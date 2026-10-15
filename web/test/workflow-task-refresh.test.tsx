import { expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { canRetrieveGenerationResult, type GenerationTask } from "@/services/api/task-center";
import { latestWorkflowTestTask, matchesWorkflowTestTask } from "@/services/workflow-test-task";
import { ApiError } from "@/services/api/request";
import { CanvasGenerationTaskRefresh } from "@/components/canvas/canvas-generation-task-refresh";
import { CanvasNodeActionContext } from "@/components/canvas/canvas-node-action-context";
import { WorkflowTestWorkbench } from "@/components/workflow-test-workbench";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const identity = { workflowId: "flow", kind: "workflow" as const, capability: "text" as const };
const task: GenerationTask = { id: "accepted-task", type: "canvas_text", provider: "runninghub", providerRequestId: "original-id", status: "failed", prompt: "", attempts: 1, createdAt: "", updatedAt: "", inputJson: JSON.stringify({ metadata: { source: "workflow_settings_test", workflowId: "flow", workflowKind: "workflow" } }) };

test("every workflow output type can retrieve an accepted failed task; unsent or cancelled tasks cannot", () => {
    for (const type of ["canvas_text", "canvas_image", "canvas_video", "canvas_audio"]) expect(canRetrieveGenerationResult({ ...task, type })).toBe(true);
    expect(canRetrieveGenerationResult({ ...task, providerRequestId: undefined })).toBe(false);
    expect(canRetrieveGenerationResult({ ...task, status: "cancelled" })).toBe(false);
    expect(canRetrieveGenerationResult({ ...task, provider: "openai" })).toBe(false);
});

test("test task lookup uses the durable task ID and rejects another workflow or App", async () => {
    let lists = 0;
    const deps = { readId: async () => task.id, queryTask: async () => task, listTasks: async () => { lists++; return []; } };
    expect((await latestWorkflowTestTask(identity, undefined, deps))?.id).toBe(task.id);
    expect(lists).toBe(0);
    expect(matchesWorkflowTestTask(task, { ...identity, workflowId: "other" })).toBe(false);
    expect(matchesWorkflowTestTask(task, { ...identity, kind: "app" })).toBe(false);
    expect(matchesWorkflowTestTask({ ...task, inputJson: "bad JSON" }, identity)).toBe(false);
    expect(await latestWorkflowTestTask({ ...identity, kind: "app" }, undefined, deps)).toBeNull();
});

test("test task lookup recovers from a deleted pointer but preserves network errors and cancellation", async () => {
    const deps = { readId: async () => "deleted", queryTask: async (id: string) => { if (id === "deleted") throw new ApiError("gone", { status: 404 }); return task; }, listTasks: async () => [task] };
    expect((await latestWorkflowTestTask(identity, undefined, deps))?.id).toBe(task.id);
    await expect(latestWorkflowTestTask(identity, undefined, { ...deps, queryTask: async () => { throw new ApiError("network", { status: 502 }); } })).rejects.toThrow("network");
    const request = new AbortController(); request.abort();
    await expect(latestWorkflowTestTask(identity, request.signal, deps)).rejects.toThrow("Aborted");
});

test("reopening the test canvas locates the task from a summary and fetches its full result", async () => {
    const reads: string[] = [];
    const summary = { ...task, inputJson: undefined, clientContext: { source: "workflow_settings_test", workflowId: "flow", workflowKind: "workflow" as const } };
    const found = await latestWorkflowTestTask(identity, undefined, { readId: async () => null, listTasks: async () => [summary], queryTask: async (id) => { reads.push(id); return task; } });
    expect(found).toBe(task);
    expect(reads).toEqual([task.id]);
});

test("test and canvas views provide a refresh command without exposing it on regular model nodes", () => {
    const node: CanvasNodeData = { id: "node", type: CanvasNodeType.Text, width: 320, height: 200, position: { x: 0, y: 0 }, metadata: { taskId: task.id, taskProvider: "runninghub", status: "error" } };
    const render = (candidate: CanvasNodeData) => renderToStaticMarkup(<App><CanvasNodeActionContext.Provider value={{ refreshTaskResult: async () => {} }}><CanvasGenerationTaskRefresh node={candidate} /></CanvasNodeActionContext.Provider></App>);
    expect(render(node)).toContain("刷新结果");
    expect(render({ ...node, metadata: { taskId: task.id, taskProvider: "openai" } })).not.toContain("刷新结果");
    const markup = renderToStaticMarkup(<App><WorkflowTestWorkbench provider="runninghub" {...identity} workflowKind="workflow" title="flow" fields={[{ nodeId: "20", fieldName: "image", source: "referenceImage", imageOrder: 6, enabled: true }]} /></App>);
    expect(markup).toContain("刷新结果");
    expect(markup).toContain("使用工作流默认素材");
    expect(markup).toContain("20.image");
});
