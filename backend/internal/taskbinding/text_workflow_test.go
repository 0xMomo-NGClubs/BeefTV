package taskbinding

import (
	"errors"
	"testing"

	localtask "infinite-canvas/backend/internal/task"
)

func TestWorkflowTextBindsSelectedNonzeroSlotWithoutMediaReads(t *testing.T) {
	task := testImageTask()
	task.Type = "canvas_text"
	task.ResultJSON = `{"primaryOutputId":"output:1","outputs":[{"mediaType":"text","text":"report"},{"mediaType":"text","text":"<Picture 1> prompt","sourceNodeId":"19"}]}`
	ports := &fakePorts{task: task, outputs: localtask.CanonicalOutputs(task.ResultJSON, task.Type), resErr: errors.New("text must not read media resources"), assetErr: errors.New("text must not read assets")}
	receipt, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: task.ID, NodeID: "node-1", OutputIndex: 1})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.MediaType != "text" || receipt.Content != "<Picture 1> prompt" || receipt.AssetID != "" || receipt.ResourceID != "" || len(ports.lastPatch.GenerationOutputs) != 2 {
		t.Fatalf("receipt=%#v patch=%#v", receipt, ports.lastPatch)
	}
	ports.outputs[1].Text = "different text"
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: task.ID, NodeID: "node-1", OutputIndex: 1}); err == nil {
		t.Fatal("unconfirmed text value accepted")
	}
	ports.task.UserID = "other-user"
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: task.ID, NodeID: "node-1", OutputIndex: 1}); err == nil {
		t.Fatal("foreign text task accepted")
	}
}

func TestAmbiguousTextWorkflowBindsCollectionWithoutChoosingFirstText(t *testing.T) {
	task := testImageTask()
	task.Type = "canvas_text"
	task.ResultJSON = `{"outputParameterWarning":"choose a text output","outputs":[{"mediaType":"text","text":"first"},{"mediaType":"text","text":"second"}]}`
	ports := &fakePorts{task: task, outputs: localtask.CanonicalOutputs(task.ResultJSON, task.Type)}
	if _, err := Bind(ports, "user-1", Request{CanvasID: "canvas-1", TaskID: task.ID, NodeID: "node-1"}); err != nil {
		t.Fatal(err)
	}
	if !ports.lastPatch.CollectionOnly || ports.lastPatch.Content != "" || ports.lastPatch.MediaType != "text" {
		t.Fatalf("patch=%#v", ports.lastPatch)
	}
}
