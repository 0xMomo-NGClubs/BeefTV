package workflow

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func mediaChainFixture(t *testing.T) (map[string]interface{}, Field, []InputTarget) {
	t.Helper()
	data, err := os.ReadFile("testdata/media-input-chains.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Graph   map[string]interface{} `json:"graph"`
		Field   Field                  `json:"field"`
		Targets []InputTarget          `json:"targets"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture.Graph, fixture.Field, fixture.Targets
}

func TestMediaChainsOnlyDisconnectFinalInputs(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		for _, count := range []int{0, 1, 2} {
			graph, field, targets := mediaChainFixture(t)
			if got := workflowRecommendedImageTargets(graph, field); !reflect.DeepEqual(got, targets) {
				t.Fatalf("frontend/backend path contract differs: %#v", got)
			}
			if got := workflowInputTargets(graph, field); len(got) != 4 {
				t.Fatalf("merge, linked controls, mask or unknown node crossed: %#v", got)
			}
			policy := "disconnect"
			if explicit {
				field.EmptyInputMode, field.EmptyInputTargets, policy = "disconnect", targets, "retain"
			}
			before, _ := json.Marshal(graph)
			next, changed, err := workflowWithProvidedMedia(graph, []Field{field}, map[string]int{"image": count}, policy)
			if err != nil || changed != (count < 2) {
				t.Fatalf("explicit=%v count=%d changed=%v err=%v", explicit, count, changed, err)
			}
			inputs := next["20"].(map[string]interface{})["inputs"].(map[string]interface{})
			for _, target := range targets {
				_, present := inputs[target.InputName]
				if present != (count >= 2) {
					t.Fatalf("slot %s changed incorrectly", target.InputName)
				}
			}
			// Shared crop/save branch, both merge inputs, and the supplied image remain.
			for id, original := range graph {
				if id != "20" && !reflect.DeepEqual(next[id], original) {
					t.Fatalf("shared or intermediate node %s changed", id)
				}
			}
			for _, name := range []string{"reference_images.reference_image_2", "reference_images.reference_image_3", "reference_images.reference_image_4", "reference_images.reference_image_5", "reference_images.reference_image_6", "prompt"} {
				if !reflect.DeepEqual(inputs[name], graph["20"].(map[string]interface{})["inputs"].(map[string]interface{})[name]) {
					t.Fatalf("protected branch %s changed", name)
				}
			}
			after, _ := json.Marshal(graph)
			if string(before) != string(after) {
				t.Fatal("template mutated")
			}
		}
	}
}

func TestMediaChainPinsRejectChangedGraphBeforeUpload(t *testing.T) {
	for _, scenario := range []string{"class", "rewired", "mask", "missing", "linked control", "cycle", "path pin", "path order", "root kind", "merge", "unknown"} {
		t.Run(scenario, func(t *testing.T) {
			graph, field, targets := mediaChainFixture(t)
			field.EmptyInputMode, field.EmptyInputTargets = "disconnect", targets
			inputs := func(id string) map[string]interface{} {
				return graph[id].(map[string]interface{})["inputs"].(map[string]interface{})
			}
			switch scenario {
			case "class":
				graph["10"].(map[string]interface{})["class_type"] = "OtherScale"
			case "rewired":
				inputs("11")["image"] = []any{"2", 0}
			case "mask":
				inputs("10")["image"] = []any{"1", 1}
			case "missing":
				delete(graph, "10")
			case "linked control":
				inputs("10")["width"] = []any{"41", 0}
			case "cycle":
				inputs("10")["image"] = []any{"11", 0}
			case "path pin":
				field.EmptyInputTargets[0].Path[0].InputName = "width"
			case "path order":
				path := field.EmptyInputTargets[0].Path
				path[0], path[1] = path[1], path[0]
			case "root kind":
				field.Source = "referenceVideo"
			case "merge":
				field.EmptyInputTargets[0].InputName = "reference_images.reference_image_3"
				field.EmptyInputTargets[0].Path = []InputPathStep{{NodeID: "30", InputName: "image1", ClassType: "ImageBatch"}}
			case "unknown":
				field.EmptyInputTargets[0].InputName = "reference_images.reference_image_4"
				field.EmptyInputTargets[0].Path = []InputPathStep{{NodeID: "31", InputName: "image", ClassType: "CustomResize"}}
			}
			encoded, _ := json.Marshal(field)
			var saved Field
			if err := json.Unmarshal(encoded, &saved); err != nil {
				t.Fatal(err)
			}
			exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
				t.Fatalf("invalid path made upstream request: %s", req.URL)
				return nil, "", nil
			}}
			_, err := productionClient(exec).RunRunningHub(context.Background(), Input{Mode: "text", ReferenceImages: []Media{{ID: "ref", DataURL: "data:image/png;base64,YQ=="}}, Config: Config{InterfaceType: "runninghub-workflow-text", APIKey: "test", WorkflowID: "fixture", WorkflowJSON: graph, WorkflowFields: []Field{saved, {NodeID: "2", FieldName: "image", Source: "referenceImage"}}, OptionalImageMode: "retain"}})
			if err == nil || !strings.Contains(err.Error(), "已失效") {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestMediaChainCreateUploadsOnceAndKeepsOtherBranches(t *testing.T) {
	graph, field, targets := mediaChainFixture(t)
	field.EmptyInputMode, field.EmptyInputTargets = "disconnect", targets
	var uploads, creates int
	exec := &scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.HasSuffix(req.URL, "/media/upload/binary") {
			uploads++
			return []byte(`{"code":0,"data":{"fileName":"provided-upload.png"}}`), "application/json", nil
		}
		if !strings.HasSuffix(req.URL, "/create") {
			t.Fatalf("unexpected request: %s", req.URL)
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
			t.Fatal(err)
		}
		inputs := submitted["20"].(map[string]interface{})["inputs"].(map[string]interface{})
		if inputs[targets[0].InputName] != nil || inputs[targets[1].InputName] != nil || inputs["reference_images.reference_image_3"] == nil {
			t.Fatal("final optional inputs or shared merge changed incorrectly")
		}
		if !reflect.DeepEqual(submitted["30"], graph["30"]) || !reflect.DeepEqual(submitted["21"], graph["21"]) {
			t.Fatal("shared branch changed")
		}
		if len(body.Nodes) != 1 || body.Nodes[0].NodeID != "2" || body.Nodes[0].FieldValue != "provided-upload.png" {
			t.Fatalf("wrong upload binding: %#v", body.Nodes)
		}
		return []byte(`{"code":777,"msg":"mock rejection"}`), "application/json", nil
	}}
	_, err := productionClient(exec).RunRunningHub(context.Background(), Input{Mode: "text", ReferenceImages: []Media{{ID: "ref", DataURL: "data:image/png;base64,YQ=="}}, Config: Config{InterfaceType: "runninghub-workflow-text", APIKey: "test", WorkflowID: "fixture", WorkflowJSON: graph, WorkflowFields: []Field{field, {NodeID: "2", FieldName: "image", Source: "referenceImage", Required: true}}, OptionalImageMode: "retain"}})
	if err == nil || !strings.Contains(err.Error(), "mock rejection") || uploads != 1 || creates != 1 {
		t.Fatalf("uploads=%d creates=%d err=%v", uploads, creates, err)
	}
}
