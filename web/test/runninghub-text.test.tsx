import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerationTextOutput } from "@/components/generation/generation-text-output";
import { buildNodeConfig } from "@/components/canvas/canvas-node-prompt-panel";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { defaultConfig, normalizeConfigSnapshot, type AiConfig } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { RUNNINGHUB_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { addGenerationOutputNodes, generationOutputMetadata } from "@/lib/canvas/canvas-generation-outputs";
import { buildGenerationTaskNodeResult } from "@/lib/canvas/canvas-generation-task-sync";
import { reorderCanvasResourceConnections } from "@/lib/canvas/canvas-resource-references";
import { defaultWorkflowTextOutputNodeId } from "@/lib/workflow-text-outputs";
import { prepareBackendGenerationTask, parseBackendGenerationResult } from "@/services/api/generation-task";
import { materializedCanvasGenerationOutputs } from "@/services/canvas-generation-outputs";
import { readGenerationOutputBlob } from "@/services/generation-output-media";
import { createGenerationTaskMaterializer } from "@/services/generation-task-materializer";
import { projectGenerationTaskResult } from "@/services/project-asset-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { GenerationOutput } from "@/lib/generation-outputs";
import type { GenerationTask } from "@/services/api/task-center";

const oldStatuses = usePluginStore.getState().runtimeStatuses;
beforeEach(() => usePluginStore.getState().setRuntimeStatuses({ [RUNNINGHUB_PLUGIN_ID]: "enabled" }));
afterEach(() => usePluginStore.getState().setRuntimeStatuses(oldStatuses));
const prompt = "\n[00:00-00:05] <Picture 1> 与 <Picture 2> 对话。\n保留段落和标记。\n";
const outputs: GenerationOutput[] = [
    { id: "output:0", outputIndex: 0, mediaType: "text", text: "analysis report", dataUrl: "" },
    { id: "output:1", outputIndex: 1, mediaType: "text", text: prompt, dataUrl: "", sourceNodeId: "19" },
    { id: "output:2", outputIndex: 2, mediaType: "image", dataUrl: "/api/resources/preview/file", storageKey: "resource:preview", assetId: "preview-asset" },
];
const task: GenerationTask = { id: "text-task", type: "canvas_text", provider: "runninghub", status: "succeeded", progress: 100, prompt: "creative input", resultJson: JSON.stringify({ mode: "text", primaryOutputId: "output:1", outputs }), outputs: outputs.map((output) => ({ outputIndex: output.outputIndex, mediaType: output.mediaType, text: output.text, resourceId: output.mediaType === "image" ? "preview" : undefined, materializedAssetId: output.assetId })) };
const source: CanvasNodeData = { id: "enhancer", type: CanvasNodeType.Text, title: "H3 增强器", width: 360, height: 240, position: { x: 0, y: 0 }, metadata: { workflowProvider: "runninghub", runningHubWorkflowId: "enhancer-flow", runningHubWorkflowKind: "workflow", generationOutputs: outputs, generationOutputTaskId: task.id, workflowParameters: { "field:21:shot_count": "2" } } };
const config: AiConfig = { ...defaultConfig, runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "test-consumer-key", workflowId: "enhancer-flow", capability: "text", workflows: [{ workflowId: "enhancer-flow", capability: "text", primaryTextOutputNodeId: "19", fields: [{ nodeId: "21", fieldName: "shot_count", fieldValue: "auto", enabled: true }] }] } };

test("text nodes use the selected workflow and parameter overrides instead of a regular text model", async () => {
    const resolved = buildNodeConfig(config, source, "text", { capability: "text" });
    expect(resolved.taskWorkflowProvider).toBe("runninghub");
    expect(resolved.runningHub.workflows[0].fields?.[0].fieldValue).toBe("2");
    const payload = await prepareBackendGenerationTask({ mode: "text", prompt: "", config: resolved, referenceImages: [{ id: "input-image", name: "reference.png", type: "image/png", dataUrl: "blob:must-not-fetch", storageKey: "resource:input-image" }] });
    expect(payload.type).toBe("canvas_text");
    expect(payload.provider).toBe("runninghub");
    expect(payload.prompt).toBe("");
    expect(payload.input.config.interfaceType).toBe("runninghub-workflow-text");
    expect(payload.input.config.primaryTextOutputNodeId).toBe("19");
    expect(payload.input.config.apiKey).toBe("test-consumer-key");
    expect(payload.input.referenceImages[0].storageKey).toBe("resource:input-image");
    expect(payload.input.textOptions).toEqual({ stream: false, thinking: false });
    expect(buildGenerationConfig(config, { ...source, metadata: { workflowProvider: "model" } }, "text").taskWorkflowProvider).toBe("model");
});

test("text workflow configuration and an explicit output binding survive normalization", () => {
    const saved = normalizeConfigSnapshot({ config }).config;
    expect(saved.runningHub.capability).toBe("text");
    expect(saved.runningHub.workflows[0].primaryTextOutputNodeId).toBe("19");
    const schema = { "19": { class_type: "ShellAgentPluginOutputText", inputs: { output_name: "output_text" } } };
    expect(defaultWorkflowTextOutputNodeId(schema)).toBe("19");
    expect(defaultWorkflowTextOutputNodeId({ ...schema, "20": schema["19"] })).toBeUndefined();
});

test("mixed results project the chosen text and keep every other output without requiring text assets", async () => {
    expect(parseBackendGenerationResult(task).text).toBe(prompt);
    const projected = projectGenerationTaskResult(task);
    expect(projected.outputs?.[1].text).toBe(prompt);
    expect(projected.resultState).not.toBe("PENDING_MATERIALIZATION");
    expect(materializedCanvasGenerationOutputs(task, outputs).map((output) => output.mediaType)).toEqual(["text", "text", "image"]);
    const updated = await buildGenerationTaskNodeResult({ ...source, metadata: { ...source.metadata, content: "old text", richText: "old rich text" } }, task);
    expect(updated.metadata?.content).toBe(prompt);
    expect(updated.metadata?.richText).toBeUndefined();
    expect(updated.metadata?.primaryOutputId).toBe("output:1");
    expect(updated.metadata?.generationOutputs).toHaveLength(3);
});

test("text actions reject edited values and missing canonical delivery", () => {
    expect(() => materializedCanvasGenerationOutputs(task, [{ ...outputs[1], text: "fake text" }])).toThrow("已发生变化");
    expect(() => materializedCanvasGenerationOutputs({ ...task, outputs: [] }, [outputs[1]])).toThrow("尚未就绪");
    expect(() => materializedCanvasGenerationOutputs({ ...task, status: "running" }, [outputs[1]])).toThrow("尚未完成");
});

test("adding text results needs no asset id and repeated additions preserve user edits", () => {
    const added = addGenerationOutputNodes([source], source, [outputs[1]]);
    expect(added[1].type).toBe(CanvasNodeType.Text);
    expect(added[1].metadata?.content).toBe(prompt);
    expect(added[1].metadata?.assetId).toBeUndefined();
    const edited = added.map((node, index) => index ? { ...node, metadata: { ...node.metadata, content: "manual edit" } } : node);
    expect(addGenerationOutputNodes(edited, source, [outputs[1]])).toBe(edited);
    const more = addGenerationOutputNodes(edited, source, [outputs[0]]);
    expect(more[2].position).not.toEqual(more[1].position);
    expect(generationOutputMetadata(outputs[0]).content).toBe("analysis report");
});

test("ambiguous or missing primary text remains a result collection and clears old rich text", async () => {
    const ambiguous = { ...task, resultJson: JSON.stringify({ mode: "text", outputs, outputParameterWarning: "请选择主文字输出" }) };
    expect(parseBackendGenerationResult(ambiguous).text).toBeUndefined();
    const updated = await buildGenerationTaskNodeResult({ ...source, metadata: { ...source.metadata, content: "old", richText: "old" } }, ambiguous);
    expect(updated.metadata?.content).toBeUndefined();
    expect(updated.metadata?.richText).toBeUndefined();
    expect(updated.metadata?.primaryOutputId).toBeUndefined();
    expect(updated.metadata?.generationOutputs).toHaveLength(3);
});

test("text outputs do not enter the media materializer", async () => {
    const materializer = createGenerationTaskMaterializer({ effects: {} as never, materializeOutput: async () => { throw new Error("text entered media materialization"); } });
    const textTask = { ...task, outputs: task.outputs?.filter((output) => output.mediaType === "text") };
    const materialized = await materializer.materialize(textTask);
    expect(materialized.resultState).toBe("READY");
    expect(materialized.outputs?.[1].text).toBe(prompt);
});

test("generated H3 text connects to a video workflow with reference order preserved", () => {
    const textNode = addGenerationOutputNodes([source], source, [outputs[1]])[1];
    const images: CanvasNodeData[] = ["a", "b"].map((id) => ({ id, type: CanvasNodeType.Image, title: id, width: 200, height: 200, position: { x: 0, y: 0 }, metadata: { content: "data:image/png;base64,cGl4ZWw=", naturalWidth: 200, naturalHeight: 200 } }));
    const video: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "视频", width: 400, height: 300, position: { x: 0, y: 0 }, metadata: { workflowProvider: "runninghub", runningHubWorkflowId: "video-flow" } };
    const nodes = [video, textNode, ...images];
    const connections = reorderCanvasResourceConnections(video.id, ["b", textNode.id, "a"], nodes, [textNode, ...images].map((node) => ({ id: `edge-${node.id}`, fromNodeId: node.id, toNodeId: video.id })));
    const context = buildNodeGenerationContext(video.id, nodes, connections, "", []);
    expect(context.prompt).toBe(prompt.trim());
    expect(context.referenceImages.map((image) => image.id)).toEqual(["b", "a"]);
});

test("text preview escapes markup and TXT preserves original paragraphs", async () => {
    const html = renderToStaticMarkup(<App><GenerationTextOutput text={prompt} /></App>);
    expect(html).toContain("&lt;Picture 1&gt;");
    expect(html).toContain("复制文字");
    const blob = await readGenerationOutputBlob(outputs[1]);
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(await blob.text()).toBe(prompt);
});
