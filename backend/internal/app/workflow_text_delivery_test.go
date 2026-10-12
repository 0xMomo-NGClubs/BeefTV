package app

import (
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func TestWorkflowTextDeliverySurvivesReopenWithoutCreatingAssets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workflow-text.db")
	svc, db := newGenerationDeliveryService(t, path)
	now := time.Now()
	task := model.Task{ID: "text-workflow-task", UserID: "user-1", Type: "canvas_text", Status: model.TaskStatusSucceeded, InputJSON: `{"metadata":{"source":"canvas","nodeId":"text-node"}}`, ResultJSON: `{"mode":"text","primaryOutputId":"output:1","outputs":[{"id":"output:0","mediaType":"text","text":"analysis"},{"id":"output:1","mediaType":"text","text":"<Picture 1>\n增强后的提示词","sourceNodeId":"19"}]}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := svc.generationDeliverer().Deliver(task); err != nil {
			t.Fatal(err)
		}
	}
	closeDB(t, db)
	reopened, db := newGenerationDeliveryService(t, path)
	defer closeDB(t, db)
	outputs, err := reopened.generationDeliverer().LoadedOutputs(task.ID)
	if err != nil || len(outputs) != 2 || outputs[1].Text != "<Picture 1>\n增强后的提示词" || localtask.ResultState(task.Status, outputs, false) != localtask.ResultStateReady || !localtask.DeliveryComplete(task.ResultJSON, outputs, task.Type) {
		t.Fatalf("outputs=%#v err=%v", outputs, err)
	}
	for _, output := range outputs {
		if output.ResourceID != "" || output.MaterializedAssetID != "" {
			t.Fatal("text was converted into a media asset")
		}
	}
	public, err := reopened.Task("user-1", task.ID)
	if err != nil || public == nil || len(public.Outputs) != 2 || public.Outputs[1].Text != outputs[1].Text || public.ResultState != localtask.ResultStateReady {
		t.Fatalf("public task lost durable text: task=%#v error=%v", public, err)
	}
	if _, err := reopened.Task("other-user", task.ID); err == nil {
		t.Fatal("another owner could read workflow text")
	}
	bindings := canvasBindTargets(task, localtask.CanvasBindingIntents(task.ID, outputs))
	if len(bindings) != 1 || bindings[0].outputIndex != 1 {
		t.Fatalf("bindings=%#v", bindings)
	}
	var count int64
	if err := db.Model(&model.Asset{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("assets=%d err=%v", count, err)
	}
}
