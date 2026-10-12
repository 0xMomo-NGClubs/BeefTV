package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

func TestRunningHubTextTaskManualRefreshRecoversWithoutSubmitting(t *testing.T) {
	allowLoopbackProviderTest(t)
	polls := 0
	state := "running"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/task/openapi/outputs" {
			t.Errorf("refresh made a non-query request: %s", r.URL.Path)
			http.Error(w, "unexpected", 500)
			return
		}
		polls++
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["taskId"] != "original-paid-task" {
			t.Errorf("wrong provider id: %s", body["taskId"])
		}
		w.Header().Set("Content-Type", "application/json")
		if state == "running" {
			_, _ = fmt.Fprint(w, `{"code":804,"msg":"APIKEY_TASK_IS_RUNNING"}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"code":0,"data":[{"text":"<Picture 1> recovered text","nodeId":"19"}]}`)
	}))
	defer server.Close()
	svc, db := newTimelineTaskTestService(t)
	svc.coordinator = platform.NewLocalCoordinator()
	svc.dataDir = t.TempDir()
	now := time.Now()
	input := canvasGenerationInput{Mode: "text", Config: providerConfig{InterfaceType: "runninghub-workflow-text", BaseURL: server.URL, APIKey: "synthetic-key", WorkflowID: "workflow", PrimaryTextOutputNodeID: "19"}}
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var secretInput map[string]any
	if err := json.Unmarshal(raw, &secretInput); err != nil {
		t.Fatal(err)
	}
	if err := svc.protectTaskSecrets(secretInput); err != nil {
		t.Fatal(err)
	}
	encrypted, err := json.Marshal(secretInput)
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "refresh-text", UserID: "user", Type: "canvas_text", Provider: "runninghub", ProviderRequestID: "original-paid-task", Status: model.TaskStatusFailed, Error: "EOF", InputJSON: string(encrypted), CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.QueryProviderTask(context.Background(), "other-user", task.ID); err == nil || polls != 0 {
		t.Fatal("foreign owner queried provider")
	}
	pending, err := svc.QueryProviderTask(context.Background(), task.UserID, task.ID)
	if err != nil || pending.Recovered || pending.ProviderStatus != "running" || polls != 1 {
		t.Fatalf("pending=%#v err=%v polls=%d", pending, err, polls)
	}
	state = "succeeded"
	recovered, err := svc.QueryProviderTask(context.Background(), task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !recovered.Recovered || recovered.Task.Status != model.TaskStatusSucceeded || recovered.Task.Error != "" || len(recovered.Task.Outputs) != 1 || recovered.Task.Outputs[0].Text != "<Picture 1> recovered text" {
		t.Fatalf("recovery=%#v", recovered)
	}
	if polls != 2 {
		t.Fatalf("polls=%d", polls)
	}
	again, err := svc.QueryProviderTask(context.Background(), task.UserID, task.ID)
	if err != nil || again.Task.Status != model.TaskStatusSucceeded || polls != 2 {
		t.Fatalf("completed refresh created a new query: result=%#v err=%v polls=%d", again, err, polls)
	}
	var assets int64
	if err := db.Model(&model.Asset{}).Count(&assets).Error; err != nil || assets != 0 {
		t.Fatalf("text became an asset: %d %v", assets, err)
	}
}

func TestRunningHubTextPollingRetriesEOFWithoutCreatingTask(t *testing.T) {
	allowLoopbackProviderTest(t)
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/task/openapi/outputs" {
			t.Errorf("unexpected request: %s", r.URL.Path)
			return
		}
		polls++
		if polls == 1 {
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"code":0,"data":[{"text":"recovered","nodeId":"19"}]}`)
	}))
	defer server.Close()
	policy := fastVideoPollPolicy()
	config := providerConfig{BaseURL: server.URL, APIKey: "synthetic-key", PrimaryTextOutputNodeID: "19"}
	result, err := (&Service{}).workflowClient(&policy).Poll(context.Background(), workflowConfigFromProvider(config), server.URL, "original-paid-task", "text")
	if err != nil || result["mode"] != "text" || result["primaryOutputId"] != "output:0" || polls != 2 {
		t.Fatalf("result=%#v err=%v polls=%d", result, err, polls)
	}
}
