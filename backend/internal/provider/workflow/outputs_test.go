package workflow

import (
	"context"
	"strings"
	"testing"
)

func TestWorkflowRetainsMixedOutputsAndOriginOnResume(t *testing.T) {
	creates := 0
	client := productionClient(&scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		if strings.Contains(req.URL, "/outputs") {
			return []byte(`{"code":0,"data":[{"fileUrl":"https://cdn.example/preview.png","nodeId":"8"},{"fileUrl":"https://cdn.example/a.mp4","nodeId":"9"},{"fileUrl":"https://cdn.example/b.mp4","nodeId":"9"},{"fileUrl":"https://cdn.example/a.wav"},{"fileUrl":"https://cdn.example/b.wav"},{"fileUrl":"https://cdn.example/meta.json"}]}`), "application/json", nil
		}
		if req.Kind == "create" {
			creates++
		}
		mimeType := "application/octet-stream"
		if strings.HasSuffix(req.URL, ".json") {
			mimeType = "application/json"
		}
		return []byte("artifact"), mimeType, nil
	}})
	result, err := client.RunRunningHub(context.Background(), Input{Mode: "video", ResumedRequestID: "original-task", Config: Config{InterfaceType: "runninghub-workflow-video", BaseURL: "https://www.runninghub.cn", APIKey: "test"}})
	if err != nil {
		t.Fatal(err)
	}
	outputs := result["outputs"].([]map[string]interface{})
	want := []string{"image", "video", "video", "audio", "audio", "file"}
	if len(outputs) != len(want) || creates != 0 {
		t.Fatalf("outputs=%d creates=%d", len(outputs), creates)
	}
	for index, kind := range want {
		if outputs[index]["mediaType"] != kind || outputs[index]["outputIndex"] != index {
			t.Fatalf("output %d: %#v", index, outputs[index])
		}
	}
	if outputs[1]["sourceNodeId"] != "9" {
		t.Fatal("lost output origin")
	}
	if _, ok := result["video"]; ok {
		t.Fatal("duplicated video bytes outside canonical outputs")
	}
}

func TestOutputCollectorPreservesProviderOrderAndDistinctOrigins(t *testing.T) {
	outputs := runningHubOutputs([]any{map[string]any{"fileUrl": "https://cdn.example/a.mp4", "nodeId": "9"}, map[string]any{"fileUrl": "https://cdn.example/a.mp4", "nodeId": "10"}, map[string]any{"fileUrl": "https://cdn.example/a.mp4", "nodeId": "9"}})
	if len(outputs) != 2 || outputs[0].NodeID != "9" || outputs[1].NodeID != "10" {
		t.Fatalf("outputs=%#v", outputs)
	}
}
