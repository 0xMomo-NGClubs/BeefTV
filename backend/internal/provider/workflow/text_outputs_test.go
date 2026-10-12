package workflow

import (
	"context"
	"encoding/json"
	"testing"
)

func TestTextWorkflowUploadSubmitAndMixedOutputResume(t *testing.T) {
	text := "\n[00:00-00:05] <Picture 1> 人物转身。\n保留原来的行距。\n"
	creates, uploads, downloads := 0, 0, 0
	client := productionClient(&scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		switch req.Kind {
		case "upload":
			uploads++
			authorized := false
			for _, header := range req.Headers {
				if header.Name == "Authorization" && header.Value == "Bearer test-consumer-key" {
					authorized = true
				}
			}
			if !authorized {
				t.Fatal("upload did not use the workflow credential")
			}
			return []byte(`{"code":0,"data":{"fileName":"uploaded-reference.png"}}`), "application/json", nil
		case "":
			if req.URL != "https://www.runninghub.cn/task/openapi/create" {
				t.Fatalf("unexpected metadata request: %s", req.URL)
			}
			creates++
			var body map[string]any
			if err := json.Unmarshal(req.Body, &body); err != nil {
				t.Fatal(err)
			}
			if body["apiKey"] != "test-consumer-key" {
				t.Fatal("submit did not use workflow key")
			}
			fields, _ := body["nodeInfoList"].([]any)
			if len(fields) != 1 || fields[0].(map[string]any)["nodeId"] != "20" || fields[0].(map[string]any)["fieldValue"] != "uploaded-reference.png" {
				t.Fatalf("wrong upload slot: %#v", fields)
			}
			return []byte(`{"code":0,"data":{"taskId":"text-task"}}`), "application/json", nil
		case "poll":
			body, _ := json.Marshal(map[string]any{"code": 0, "data": []any{map[string]any{"fileUrl": "https://cdn.example/preview.png", "nodeId": "17"}, map[string]any{"text": text, "fileType": "txt", "nodeId": "19"}}})
			return body, "application/json", nil
		case "download":
			downloads++
			return []byte("preview"), "image/png", nil
		default:
			t.Fatalf("unexpected request: %s", req.Kind)
			return nil, "", nil
		}
	}})
	input := Input{Mode: "text", Config: Config{InterfaceType: "runninghub-workflow-text", BaseURL: "https://www.runninghub.cn", APIKey: "test-consumer-key", WorkflowID: "prompt-enhancer", PrimaryTextOutputNodeID: "19", WorkflowJSON: map[string]any{"20": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "original.png"}}}, WorkflowFields: []Field{{NodeID: "20", FieldName: "image", Source: "referenceImage"}}}, ReferenceImages: []Media{{ID: "image-1", DataURL: "data:image/png;base64,cHJldmlldw=="}}}
	for attempt := 0; attempt < 2; attempt++ {
		if attempt == 1 {
			input.ResumedRequestID = "text-task"
		}
		result, err := client.RunRunningHub(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		outputs := result["outputs"].([]map[string]interface{})
		if len(outputs) != 2 || outputs[0]["mediaType"] != "image" || outputs[1]["text"] != text || outputs[1]["sourceNodeId"] != "19" || result["primaryOutputId"] != "output:1" || result["mode"] != "text" {
			t.Fatalf("result=%#v", result)
		}
		if _, duplicated := result["text"]; duplicated {
			t.Fatal("primary text must be a projection, not a duplicate stored value")
		}
	}
	if creates != 1 || uploads != 1 || downloads != 2 {
		t.Fatalf("creates=%d uploads=%d downloads=%d", creates, uploads, downloads)
	}
}

func TestTextOutputsStaySeparateFromCaptionsAndURLs(t *testing.T) {
	outputs := runningHubOutputs([]any{
		map[string]any{"fileUrl": "https://cdn.example/a.png", "text": "image caption", "fileType": "png", "nodeId": "17"},
		map[string]any{" Text ": "https://example.com is the generated text", "outputType": "txt", "url": "https://cdn.example/a.txt", "nodeId": "19"},
		map[string]any{"content": "second text", "nodeId": "20"},
		map[string]any{"text": "second text", "nodeId": "21"},
	})
	if len(outputs) != 4 || outputs[0].Text != "" || outputs[1].URL != "" || outputs[1].Text != "https://example.com is the generated text" || outputs[2].NodeID == outputs[3].NodeID {
		t.Fatalf("outputs=%#v", outputs)
	}
}

func TestTextOnlyResultsNeedNoDownloadAndChooseOnlyUnambiguousPrimary(t *testing.T) {
	client := productionClient(&scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
		t.Fatal("inline text caused a request")
		return nil, "", nil
	}})
	result, err := client.downloadWorkflowOutputs(context.Background(), []workflowOutput{{Text: "first", NodeID: "19"}, {Text: "second", NodeID: "20"}}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, nodeID := range []string{"", "missing"} {
		selectWorkflowTextOutput(result, nodeID)
		if result["primaryOutputId"] != nil || result["outputParameterWarning"] == nil {
			t.Fatalf("ambiguous text selected: %#v", result)
		}
	}
	delete(result, "outputParameterWarning")
	selectWorkflowTextOutput(result, "20")
	if result["primaryOutputId"] != "output:1" {
		t.Fatalf("wrong selected text: %#v", result)
	}
}

func TestTXTDownloadDecodesTextWithoutCreatingMedia(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		client := productionClient(&scriptedExecutor{handler: func(req Request) ([]byte, string, error) {
			if invalid {
				return []byte{0xff}, "application/octet-stream", nil
			}
			return []byte("\xef\xbb\xbf<Picture 1>\n第二行"), "application/octet-stream", nil
		}})
		result, err := client.DownloadOutputs(context.Background(), []string{"https://cdn.example/prompt.txt"}, "", nil)
		if invalid {
			if err == nil {
				t.Fatal("invalid UTF-8 accepted")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		output := result["outputs"].([]map[string]interface{})[0]
		if output["mediaType"] != "text" || output["text"] != "<Picture 1>\n第二行" || output["dataUrl"] != "" {
			t.Fatalf("output=%#v", output)
		}
	}
}

func TestTextWorkflowDefaultsIgnoreThePreviewImageBranch(t *testing.T) {
	workflow := map[string]any{
		"16": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "preview.png"}},
		"17": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{"images": []any{"16", 0}}},
		"20": map[string]any{"class_type": "LoadImage", "inputs": map[string]any{"image": "reference.png"}},
		"21": map[string]any{"class_type": "MiniMaxH3PromptEnhancerT8", "inputs": map[string]any{"prompt": "creative input", "reference_images.reference_image_0": []any{"20", 0}, "api_key": []any{"23", 0}}},
		"23": map[string]any{"class_type": "CR Prompt Text", "inputs": map[string]any{"prompt": ""}},
		"19": map[string]any{"class_type": "ShellAgentPluginOutputText", "inputs": map[string]any{"text": []any{"21", 0}, "output_name": "output_text"}},
	}
	fields := CollectFields(workflow, "text")
	for _, field := range fields {
		id := field["nodeId"]
		if id == "16" && field["fieldName"] == "image" && field["enabled"] != false {
			t.Fatal("preview branch consumed reference slot")
		}
		if id == "20" && field["fieldName"] == "image" && (field["sourceIndex"] != 0 || field["enabled"] != true) {
			t.Fatalf("reference slot: %#v", field)
		}
		if id == "23" && field["source"] == "prompt" {
			t.Fatal("creative input was bound to the credential branch")
		}
	}
	if err := ValidateConfig("text", Config{InterfaceType: "runninghub-workflow-text", BaseURL: "https://www.runninghub.cn", APIKey: "test", WorkflowID: "wf"}); err != nil {
		t.Fatal(err)
	}
}
