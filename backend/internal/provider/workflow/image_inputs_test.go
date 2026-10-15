package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func sixReferenceWorkflow() (map[string]interface{}, []Field) {
	graph := map[string]interface{}{
		"21": map[string]interface{}{"class_type": "MiniMaxH3PromptEnhancerT8", "inputs": map[string]interface{}{"prompt": "original", "api_key": []any{"23", 0}}},
		"23": map[string]interface{}{"class_type": "CR Prompt Text", "inputs": map[string]interface{}{"prompt": ""}},
		"19": map[string]interface{}{"class_type": "ShellAgentPluginOutputText", "inputs": map[string]interface{}{"text": []any{"21", 0}}},
		"17": map[string]interface{}{"class_type": "SaveImage", "inputs": map[string]interface{}{"images": []any{"25", 0}}},
	}
	fields := []Field{{NodeID: "21", FieldName: "prompt", Source: "prompt"}}
	for i, id := range []string{"20", "25", "26", "27", "28", "29"} {
		graph[id] = map[string]interface{}{"class_type": "LoadImage", "inputs": map[string]interface{}{"image": "default-" + id + ".png"}}
		graph["21"].(map[string]interface{})["inputs"].(map[string]interface{})[fmt.Sprintf("reference_images.reference_image_%d", i)] = []any{id, 0}
		fields = append(fields, Field{NodeID: id, FieldName: "image", Source: "referenceImage", SourceIndex: i, ImageOrder: i + 1, Required: i == 0})
	}
	return graph, fields
}

func TestProvidedImagesDisconnectDynamicPortsWithoutMutatingTemplate(t *testing.T) {
	for _, count := range []int{1, 3, 6} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			graph, fields := sixReferenceWorkflow()
			before, _ := json.Marshal(graph)
			next, changed, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": count}, "disconnect")
			if err != nil || changed != (count < 6) {
				t.Fatalf("changed=%v err=%v", changed, err)
			}
			inputs := next["21"].(map[string]interface{})["inputs"].(map[string]interface{})
			for i := 0; i < 6; i++ {
				link, ok := inputs[fmt.Sprintf("reference_images.reference_image_%d", i)]
				if ok != (i < count) {
					t.Fatalf("slot %d present=%v, provided=%d", i, ok, count)
				}
				if ok && stringValue(link.([]any)[0]) != fields[i+1].NodeID {
					t.Fatal("reference order changed")
				}
			}
			originalOutput, _ := json.Marshal(graph["17"])
			newOutput, _ := json.Marshal(next["17"])
			if string(originalOutput) != string(newOutput) || stringValue(inputs["api_key"].([]any)[0]) != "23" {
				t.Fatal("unrelated output or credential link changed")
			}
			after, _ := json.Marshal(graph)
			if string(before) != string(after) {
				t.Fatal("saved template mutated")
			}
		})
	}
}

func TestProvidedImagesPreserveExplicitDefaultsFixedPortsAndMasks(t *testing.T) {
	graph, fields := sixReferenceWorkflow()
	fields[2].Enabled = ptr(false)
	fields[3].Required = true
	fields[4].Source = ""
	fields[4].sourceConfigured = true
	inputs := graph["21"].(map[string]interface{})["inputs"].(map[string]interface{})
	inputs["first_frame"] = []any{"28", 0}
	inputs["reference_images.reference_image_5"] = []any{"29", 1} // LoadImage's mask output.
	next, _, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 1}, "")
	if err != nil {
		t.Fatal(err)
	}
	result := next["21"].(map[string]interface{})["inputs"].(map[string]interface{})
	for _, name := range []string{"reference_images.reference_image_1", "reference_images.reference_image_2", "reference_images.reference_image_3", "reference_images.reference_image_5", "first_frame"} {
		if result[name] == nil {
			t.Fatalf("protected input %s removed", name)
		}
	}
	if result["reference_images.reference_image_4"] != nil {
		t.Fatal("empty optional dynamic image still connected")
	}
	if _, changed, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 1}, "retain"); err != nil || changed {
		t.Fatalf("retain defaults: changed=%v err=%v", changed, err)
	}
	if _, _, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 1}, "unknown"); err == nil {
		t.Fatal("unknown strategy accepted")
	}
}

func TestDynamicRunningHubCreateSendsWorkflowAndMappedUploadsOnce(t *testing.T) {
	for _, mode := range []string{"text", "image", "video", "audio"} {
		t.Run(mode, func(t *testing.T) {
			graph, fields := sixReferenceWorkflow()
			var uploads, creates int
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				if strings.HasSuffix(req.URL, "/media/upload/binary") {
					uploads++
					return []byte(`{"code":0,"data":{"fileName":"uploaded.png"}}`), "application/json", nil
				}
				if !strings.HasSuffix(req.URL, "/create") {
					t.Fatalf("unexpected request %s", req.URL)
				}
				creates++
				var body struct {
					Workflow string                                           `json:"workflow"`
					Nodes    []struct{ NodeID, FieldName, FieldValue string } `json:"nodeInfoList"`
				}
				if err := json.Unmarshal(req.Body, &body); err != nil {
					t.Fatal(err)
				}
				var submitted map[string]interface{}
				if err := json.Unmarshal([]byte(body.Workflow), &submitted); err != nil {
					t.Fatalf("full workflow missing: %v", err)
				}
				inputs := submitted["21"].(map[string]interface{})["inputs"].(map[string]interface{})
				if inputs["reference_images.reference_image_0"] == nil || inputs["reference_images.reference_image_1"] != nil {
					t.Fatal("default reference images remain connected")
				}
				if len(body.Nodes) != 2 || body.Nodes[0].FieldValue != "<Picture 1> woman dancing" || body.Nodes[1].NodeID != "20" || body.Nodes[1].FieldValue != "uploaded.png" {
					t.Fatalf("wrong scalar bindings: %#v", body.Nodes)
				}
				return []byte(`{"code":777,"msg":"mock rejection"}`), "application/json", nil
			}}
			_, err := productionClient(exec).RunRunningHub(context.Background(), Input{Mode: mode, Prompt: "<Picture 1> woman dancing", ReferenceImages: []Media{{ID: "ref", DataURL: "data:image/png;base64,YQ=="}}, Config: Config{InterfaceType: "runninghub-workflow-" + mode, BaseURL: "https://www.runninghub.ai", APIKey: "test", WorkflowID: "flow", WorkflowJSON: graph, WorkflowFields: fields, OptionalImageMode: "disconnect"}})
			if err == nil || !strings.Contains(err.Error(), "mock rejection") || uploads != 1 || creates != 1 {
				t.Fatalf("uploads=%d creates=%d err=%v", uploads, creates, err)
			}
		})
	}
}

func TestDynamicImagesDoNotChangePublishedAppSubmission(t *testing.T) {
	graph, _ := sixReferenceWorkflow()
	var submitted bool
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if !strings.HasSuffix(req.URL, "/ai-app/run") || strings.Contains(string(req.Body), `"workflow":`) {
			t.Fatal("App submission must use published parameters only")
		}
		submitted = true
		return []byte(`{"code":777,"msg":"mock rejection"}`), "application/json", nil
	}}
	_, err := productionClient(exec).RunRunningHub(context.Background(), Input{Mode: "text", Prompt: "hello", Config: Config{InterfaceType: "runninghub-workflow-text", BaseURL: "https://www.runninghub.ai", APIKey: "test", WebappID: "app", WorkflowJSON: graph, WorkflowFields: []Field{{NodeID: "21", FieldName: "prompt", Source: "prompt"}}, OptionalImageMode: "disconnect"}})
	if !submitted || err == nil || !strings.Contains(err.Error(), "mock rejection") {
		t.Fatalf("err=%v", err)
	}
}

func TestZeroImagesOnlyDisconnectsOptionalDynamicInputs(t *testing.T) {
	graph, fields := sixReferenceWorkflow()
	fields[1].Required = false
	next, changed, err := workflowWithProvidedMedia(graph, fields, map[string]int{"image": 0}, "disconnect")
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	inputs := next["21"].(map[string]interface{})["inputs"].(map[string]interface{})
	for name := range inputs {
		if strings.HasPrefix(name, "reference_images.") {
			t.Fatal("optional image still participates")
		}
	}
	if inputs["prompt"] != "original" || len(next) != len(graph) {
		t.Fatal("unrelated defaults or nodes removed")
	}
}
