package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRunningHubPromptMappingControlsSubmission(t *testing.T) {
	for _, mode := range []string{"text", "image", "video", "audio"} {
		for _, policy := range []string{"mapped", "multiple", "disabled", "fixed", "empty", "inferred"} {
			t.Run(mode+"/"+policy, func(t *testing.T) {
				input := Input{Mode: mode, Prompt: "画布文字\n\n<Picture 1> 女人在跳舞", Config: Config{
					InterfaceType: "runninghub-workflow-" + mode, BaseURL: "https://www.runninghub.cn", APIKey: "test", WorkflowID: "flow",
					WorkflowJSON: map[string]any{
						"21": map[string]any{"class_type": "MiniMaxH3PromptEnhancerT8", "inputs": map[string]any{"prompt": "original", "api_key": []any{"23", 0}}},
						"23": map[string]any{"class_type": "CR Prompt Text", "inputs": map[string]any{"prompt": ""}},
					},
					WorkflowFields: []Field{{NodeID: "21", FieldName: "prompt", Source: "prompt"}, {NodeID: "23", FieldName: "prompt", FieldValue: ""}},
				}}
				want := map[string]string{"21": input.Prompt}
				switch policy {
				case "multiple":
					input.Config.WorkflowFields[1].Source = "prompt"
					want["23"] = input.Prompt
				case "disabled":
					input.Config.WorkflowFields[0].Enabled = ptr(false)
					want = map[string]string{}
				case "fixed":
					input.Config.WorkflowFields[0].Source = ""
					input.Config.WorkflowFields[0].FieldValue = "用户设置的固定值"
					want = map[string]string{"21": "用户设置的固定值"}
				case "empty":
					input.Prompt = ""
					want = map[string]string{}
				case "inferred":
					input.Config.WorkflowFields = nil
				}
				var submitted map[string]string
				client := productionClient(&scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
					if strings.HasSuffix(req.URL, "/create") {
						var body struct {
							Nodes []struct{ NodeID, FieldName, FieldValue string } `json:"nodeInfoList"`
						}
						if err := json.Unmarshal(req.Body, &body); err != nil {
							t.Fatal(err)
						}
						submitted = map[string]string{}
						for _, node := range body.Nodes {
							if node.FieldName == "prompt" {
								submitted[node.NodeID] = node.FieldValue
							}
						}
						return []byte(`{"code":0,"data":{"taskId":"task"}}`), "application/json", nil
					}
					if req.Kind == "poll" {
						return []byte(`{"code":0,"data":[{"text":"done","nodeId":"19"}]}`), "application/json", nil
					}
					t.Fatalf("unexpected request: %s", req.URL)
					return nil, "", nil
				}})
				if _, err := client.RunRunningHub(context.Background(), input); err != nil {
					t.Fatal(err)
				}
				if len(submitted) != len(want) {
					t.Fatalf("submitted=%#v want=%#v", submitted, want)
				}
				for nodeID, text := range want {
					if submitted[nodeID] != text {
						t.Fatalf("submitted=%#v want=%#v", submitted, want)
					}
				}
			})
		}
	}
}
