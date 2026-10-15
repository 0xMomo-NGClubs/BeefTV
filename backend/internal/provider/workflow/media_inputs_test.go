package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func explicitMediaFixture(kind string) (map[string]interface{}, []Field) {
	classType := map[string]string{"image": "LoadImage", "video": "VideoLoader", "audio": "LoadAudio"}[kind]
	graph := map[string]interface{}{
		"1": map[string]interface{}{"class_type": classType, "inputs": map[string]interface{}{kind: "default.file"}},
		"2": map[string]interface{}{"class_type": "Generator", "inputs": map[string]interface{}{"optional_reference": []any{"1", 0}, "second_reference": []any{"1", 0}, "mask": []any{"1", 1}, "prompt": "keep"}},
		"3": map[string]interface{}{"class_type": "SaveImage", "inputs": map[string]interface{}{"images": []any{"1", 0}}},
	}
	field := Field{NodeID: "1", FieldName: kind, Source: "reference" + kind, EmptyInputMode: "disconnect"}
	for _, name := range []string{"optional_reference", "second_reference"} {
		field.EmptyInputTargets = append(field.EmptyInputTargets, InputTarget{NodeID: "2", InputName: name, SourceNodeID: "1", SourceOutputIndex: 0, SourceClassType: classType, TargetClassType: "Generator"})
	}
	return graph, []Field{field}
}

func TestExplicitMediaPoliciesOnlyRemoveSelectedEdges(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio"} {
		t.Run(kind, func(t *testing.T) {
			graph, fields := explicitMediaFixture(kind)
			before, _ := json.Marshal(graph)
			for _, count := range []int{0, 1} {
				next, changed, err := workflowWithProvidedMedia(graph, fields, map[string]int{kind: count}, "retain")
				if err != nil || changed != (count == 0) {
					t.Fatalf("count=%d changed=%v err=%v", count, changed, err)
				}
				inputs := next["2"].(map[string]interface{})["inputs"].(map[string]interface{})
				for _, name := range []string{"optional_reference", "second_reference"} {
					_, present := inputs[name]
					if present != (count == 1) {
						t.Fatalf("%s present=%v", name, present)
					}
				}
				if inputs["mask"] == nil || inputs["prompt"] != "keep" || next["3"].(map[string]interface{})["inputs"].(map[string]interface{})["images"] == nil || len(next) != len(graph) {
					t.Fatal("unselected branch, mask, or node changed")
				}
			}
			after, _ := json.Marshal(graph)
			if string(before) != string(after) {
				t.Fatal("saved template mutated")
			}
		})
	}
}

func TestExplicitMediaPoliciesValidatePinsEvenWhenInputIsProvided(t *testing.T) {
	for _, scenario := range []string{"missing target", "link changed", "source class", "target class", "mask", "missing source", "empty targets", "bad mode", "scalar changed"} {
		t.Run(scenario, func(t *testing.T) {
			graph, fields := explicitMediaFixture("image")
			switch scenario {
			case "missing target":
				delete(graph, "2")
			case "link changed":
				graph["2"].(map[string]interface{})["inputs"].(map[string]interface{})["optional_reference"] = []any{"9", 0}
			case "source class":
				graph["1"].(map[string]interface{})["class_type"] = "OtherLoader"
			case "target class":
				graph["2"].(map[string]interface{})["class_type"] = "OtherGenerator"
			case "mask":
				fields[0].EmptyInputTargets[0].SourceOutputIndex = 1
			case "missing source":
				delete(graph, "1")
			case "empty targets":
				fields[0].EmptyInputTargets = nil
			case "bad mode":
				fields[0].EmptyInputMode = "unknown"
			case "scalar changed":
				graph["1"].(map[string]interface{})["inputs"].(map[string]interface{})["image"] = []any{"9", 0}
			}
			if _, _, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 1}, "retain"); err == nil {
				t.Fatal("stale or invalid mapping accepted")
			}
		})
	}
}

func TestExplicitMediaPolicyOverridesAndSharedSourceProtection(t *testing.T) {
	graph, fields := explicitMediaFixture("image")
	for _, mode := range []string{"retain", "inherit"} {
		fields[0].EmptyInputMode = mode
		if _, changed, err := workflowWithProvidedMedia(graph, fields, nil, "disconnect"); err != nil || changed {
			t.Fatalf("mode=%s changed=%v err=%v", mode, changed, err)
		}
	}
	fields[0].EmptyInputMode = "disconnect"
	for _, update := range []func(*Field){func(f *Field) { f.Required = true }, func(f *Field) { f.Enabled = ptr(false) }, func(f *Field) { f.SafeToOverride = ptr(false) }, func(f *Field) { f.Source = "mask" }} {
		copy := fields[0]
		update(&copy)
		if _, changed, err := workflowWithProvidedMedia(graph, []Field{copy}, nil, "disconnect"); err != nil || changed {
			t.Fatalf("protected field changed=%v err=%v", changed, err)
		}
	}
	fields[0].SourceIndex = 2
	if _, changed, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 2}, "retain"); err != nil || !changed {
		t.Fatalf("non-contiguous empty slot changed=%v err=%v", changed, err)
	}
	fields = append(fields, Field{NodeID: "1", FieldName: "other_image", Source: "referenceImage", EmptyInputMode: "retain"})
	if _, _, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 1}, "retain"); err == nil || !strings.Contains(err.Error(), "多个素材字段") {
		t.Fatalf("shared source: %v", err)
	}
}

func TestInvalidEmptyInputMappingPreventsUploadAndPaidCreate(t *testing.T) {
	graph, fields := explicitMediaFixture("image")
	delete(graph, "2")
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		t.Fatalf("invalid mapping made request: %s", req.URL)
		return nil, "", nil
	}}
	_, err := productionClient(exec).RunRunningHub(context.Background(), Input{Mode: "text", Config: Config{InterfaceType: "runninghub-workflow-text", APIKey: "test", WorkflowID: "flow", WorkflowJSON: graph, WorkflowFields: fields, OptionalImageMode: "retain"}, ReferenceImages: []Media{{ID: "ref", DataURL: "data:image/png;base64,YQ=="}}})
	if err == nil || !strings.Contains(err.Error(), "已失效") {
		t.Fatalf("err=%v", err)
	}
}

func TestEmptyInputTargetSurvivesFieldJSONAndRequiresGraph(t *testing.T) {
	_, fields := explicitMediaFixture("audio")
	encoded, _ := json.Marshal(fields)
	var decoded []Field
	if err := json.Unmarshal(encoded, &decoded); err != nil || len(decoded) != 1 || len(decoded[0].EmptyInputTargets) != 2 {
		t.Fatalf("fields=%#v err=%v", decoded, err)
	}
	if !workflowInputGraphRequired(Config{OptionalImageMode: "retain", WorkflowFields: decoded}) {
		t.Fatal("manual media disconnection skipped graph validation")
	}
	for _, update := range []func(*Field){func(f *Field) { f.Source = "prompt" }, func(f *Field) { f.Enabled = ptr(false) }, func(f *Field) { f.Required = true }, func(f *Field) { f.SafeToOverride = ptr(false) }} {
		field := decoded[0]
		update(&field)
		if workflowInputGraphRequired(Config{OptionalImageMode: "retain", WorkflowFields: []Field{field}}) {
			t.Fatal("inactive media policy incorrectly required a mutable graph")
		}
	}
}

func TestExplicitMediaCreateUsesGraphOnlyForMissingInputs(t *testing.T) {
	for _, kind := range []string{"image", "video", "audio"} {
		for _, provided := range []bool{false, true} {
			graph, fields := explicitMediaFixture(kind)
			var uploads, creates int
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if strings.HasSuffix(req.URL, "/media/upload/binary") {
					uploads++
					return []byte(`{"code":0,"data":{"fileName":"uploaded.file"}}`), "application/json", nil
				}
				if !strings.HasSuffix(req.URL, "/create") {
					t.Fatalf("unexpected request: %s", req.URL)
				}
				creates++
				var body struct {
					Workflow string                        `json:"workflow"`
					Nodes    []struct{ FieldValue string } `json:"nodeInfoList"`
				}
				if err := json.Unmarshal(req.Body, &body); err != nil {
					t.Fatal(err)
				}
				if provided {
					if body.Workflow != "" || len(body.Nodes) != 1 || body.Nodes[0].FieldValue != "uploaded.file" {
						t.Fatalf("provided input lost its node mapping: %#v", body)
					}
				} else {
					var submitted map[string]interface{}
					if err := json.Unmarshal([]byte(body.Workflow), &submitted); err != nil {
						t.Fatal(err)
					}
					inputs := submitted["2"].(map[string]interface{})["inputs"].(map[string]interface{})
					if inputs["optional_reference"] != nil || inputs["second_reference"] != nil || inputs["mask"] == nil || len(body.Nodes) != 0 {
						t.Fatal("missing input graph or protected edge changed")
					}
				}
				return []byte(`{"code":777,"msg":"mock rejection"}`), "application/json", nil
			}}
			input := Input{Mode: "text", Config: Config{InterfaceType: "runninghub-workflow-text", APIKey: "test", WorkflowID: "flow", WorkflowJSON: graph, WorkflowFields: fields, OptionalImageMode: "retain"}}
			if provided {
				media := []Media{{ID: "ref", DataURL: "data:image/png;base64,YQ=="}}
				switch kind {
				case "image":
					input.ReferenceImages = media
				case "video":
					input.ReferenceVideos = media
				case "audio":
					input.ReferenceAudios = media
				}
			}
			_, err := productionClient(exec).RunRunningHub(context.Background(), input)
			if err == nil || !strings.Contains(err.Error(), "mock rejection") || creates != 1 || provided && uploads != 1 || !provided && uploads != 0 {
				t.Fatalf("kind=%s provided=%v creates=%d uploads=%d err=%v", kind, provided, creates, uploads, err)
			}
		}
	}
}

func TestStaleEmptyInputPolicyDoesNotChangePublishedAppOrResume(t *testing.T) {
	graph, fields := explicitMediaFixture("image")
	delete(graph, "2")
	for _, scenario := range []string{"app", "resume"} {
		t.Run(scenario, func(t *testing.T) {
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				switch {
				case scenario == "app" && strings.HasSuffix(req.URL, "/ai-app/run"):
					var body map[string]interface{}
					if err := json.Unmarshal(req.Body, &body); err != nil || body["workflow"] != nil {
						t.Fatalf("App graph rewritten: %v", err)
					}
					return []byte(`{"code":777,"msg":"mock rejection"}`), "application/json", nil
				case scenario == "resume" && strings.HasSuffix(req.URL, "/outputs"):
					var body map[string]interface{}
					_ = json.Unmarshal(req.Body, &body)
					if body["taskId"] != "original-task" {
						t.Fatal("original task identity changed")
					}
					return pngJSON(), "application/json", nil
				case scenario == "resume" && strings.HasSuffix(req.URL, "/out.png"):
					return []byte("PNGDATA"), "image/png", nil
				default:
					t.Fatalf("unexpected upload, create or schema request: %s", req.URL)
					return nil, "", nil
				}
			}}
			input := Input{Mode: "image", Config: Config{InterfaceType: "runninghub-workflow-image", APIKey: "test", WorkflowID: "flow", WorkflowJSON: graph, WorkflowFields: fields, OptionalImageMode: "retain"}}
			if scenario == "app" {
				input.Config.WebappID = "published-app"
			} else {
				input.ResumedRequestID = "original-task"
			}
			_, err := productionClient(exec).RunRunningHub(context.Background(), input)
			if scenario == "app" && (err == nil || !strings.Contains(err.Error(), "mock rejection")) || scenario == "resume" && err != nil {
				t.Fatalf("scenario=%s err=%v", scenario, err)
			}
		})
	}
}
