import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowPromptMappingEditor } from "@/components/workflow-prompt-mapping-editor";
import { WorkflowTestWorkbench } from "@/components/workflow-test-workbench";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { workflowParameterFields } from "@/lib/model-capabilities";
import { setWorkflowPromptEnabled, setWorkflowPromptTargets, workflowPromptFieldOptions, workflowPromptTargets } from "@/lib/workflow-prompt-mapping";
import { defaultConfig, mergeWorkflowFieldMappings, normalizeConfigSnapshot, type WorkflowFieldMapping } from "@/stores/use-config-store";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { RUNNINGHUB_PLUGIN_ID } from "@/lib/plugins/builtin/workflows";
import { usePluginStore } from "@/stores/use-plugin-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const fields: WorkflowFieldMapping[] = [
    { nodeId: "21", fieldName: "prompt", label: "MiniMax H3 Prompt Enhancer · prompt", fieldType: "TEXT", fieldValue: "女人在跳舞", source: "", enabled: true },
    { nodeId: "23", fieldName: "prompt", label: "提示词文本 · prompt", fieldType: "TEXT", fieldValue: "", source: "prompt", sourceAutomatic: true, enabled: true },
    { nodeId: "21", fieldName: "seed", fieldType: "NUMBER", fieldValue: 1, enabled: true },
    { nodeId: "20", fieldName: "image", fieldType: "IMAGE", source: "referenceImage", enabled: true },
    { nodeId: "24", fieldName: "unsafe", fieldType: "TEXT", safeToOverride: false },
];
const oldStatuses = usePluginStore.getState().runtimeStatuses;
beforeEach(() => usePluginStore.getState().setRuntimeStatuses({ [RUNNINGHUB_PLUGIN_ID]: "enabled" }));
afterEach(() => usePluginStore.getState().setRuntimeStatuses(oldStatuses));

test("explicit prompt mapping replaces an accidental target without changing media or other parameters", () => {
    expect(workflowPromptFieldOptions(fields).map((option) => option.value)).toEqual(["field:21:prompt", "field:23:prompt"]);
    const selected = setWorkflowPromptTargets(fields, ["field:21:prompt"]);
    expect(workflowPromptTargets(selected).map((field) => field.nodeId)).toEqual(["21"]);
    expect(selected[1]).toMatchObject({ source: "", bindPrompt: false, sourceAutomatic: false });
    expect(selected[2]).toBe(fields[2]);
    expect(selected[3]).toBe(fields[3]);
    expect(selected[0].fieldValue).toBe("女人在跳舞");
    expect(workflowParameterFields(selected).map((field) => field.nodeId)).not.toContain("20");
    expect(workflowParameterFields(selected).some((field) => field.nodeId === "21" && field.fieldName === "prompt")).toBe(false);
});

test("mapping supports multiple targets, disabling, clearing, and schema refresh without picking a replacement", () => {
    const selected = setWorkflowPromptTargets(fields, ["field:21:prompt", "field:23:prompt"]);
    expect(workflowPromptTargets(selected)).toHaveLength(2);
    const off = setWorkflowPromptEnabled(selected, false);
    expect(workflowPromptTargets(off)).toHaveLength(0);
    expect(workflowPromptTargets(off, true)).toHaveLength(2);
    expect(workflowPromptTargets(setWorkflowPromptEnabled(off, true))).toHaveLength(2);
    const cleared = setWorkflowPromptTargets(off, []);
    expect(workflowPromptTargets(cleared, true)).toHaveLength(0);
    expect(cleared[0]).toMatchObject({ source: "", enabled: true });
    const refreshed = mergeWorkflowFieldMappings(cleared, fields, "text");
    expect(workflowPromptTargets(refreshed)).toHaveLength(0);
    expect(workflowPromptTargets(mergeWorkflowFieldMappings(selected, [fields[1]], "text"))).toHaveLength(1);
    expect(workflowPromptTargets(setWorkflowPromptTargets(fields, ["field:24:unsafe", "field:missing:prompt"]))).toHaveLength(0);
});

test("connected text and node prompt use the same saved target for each workflow generation mode", async () => {
    for (const mode of ["text", "image", "video", "audio"] as const) {
        const selected = setWorkflowPromptTargets(fields.filter((field) => field.nodeId !== "20"), ["field:21:prompt"]);
        const config = { ...defaultConfig, runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "test", workflows: [{ workflowId: "flow", capability: mode, fields: selected }] } };
        const normalized = normalizeConfigSnapshot({ config }).config;
        const target: CanvasNodeData = { id: "target", type: CanvasNodeType[mode === "text" ? "Text" : mode === "image" ? "Image" : mode === "video" ? "Video" : "Audio"], position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { workflowProvider: "runninghub", runningHubWorkflowId: "flow", workflowParameters: { "field:21:prompt": "旧参数值", "source:prompt": "旧提示词来源值" } } };
        const input: CanvasNodeData = { ...target, id: "input", type: CanvasNodeType.Text, metadata: { content: "<Picture 1> 女人在跳舞" } };
        const context = buildNodeGenerationContext(target.id, [target, input], [{ id: "edge", fromNodeId: input.id, toNodeId: target.id }], "夜晚", []);
        const payload = await prepareBackendGenerationTask({ mode, prompt: context.prompt, config: buildGenerationConfig(normalized, target, mode) });
        expect(payload.prompt).toBe("夜晚\n\n<Picture 1> 女人在跳舞");
        expect(workflowPromptTargets(payload.input.config.workflowFields).map((field) => field.nodeId)).toEqual(["21"]);
        expect(payload.input.config.workflowFields.find((field) => field.nodeId === "23")?.source).toBe("");
        const offConfig = buildGenerationConfig({ ...normalized, runningHub: { ...normalized.runningHub, workflows: [{ ...normalized.runningHub.workflows[0], fields: setWorkflowPromptEnabled(selected, false) }] } }, target, mode);
        expect(offConfig.runningHub.workflows[0].fields?.[0]).toMatchObject({ source: "prompt", enabled: false, fieldValue: "女人在跳舞" });
    }
});

test("mapping editor and test canvas identify the receiving node without a duplicate prompt parameter", () => {
    const selected = setWorkflowPromptTargets(fields, ["field:21:prompt"]);
    const editor = renderToStaticMarkup(<WorkflowPromptMappingEditor fields={selected} onChange={() => {}} />);
    expect(editor).toContain("提示词输入映射");
    expect(editor).toContain("21.prompt");
    const markup = renderToStaticMarkup(<App><WorkflowTestWorkbench provider="runninghub" workflowId="flow" workflowKind="workflow" capability="text" title="增强器" fields={selected} disabled /></App>);
    expect(markup).toContain("提交到：MiniMax H3 Prompt Enhancer · prompt（21.prompt）");
    expect(markup).not.toContain("女人在跳舞");
    const off = renderToStaticMarkup(<App><WorkflowTestWorkbench provider="runninghub" workflowId="flow" workflowKind="workflow" capability="text" title="增强器" fields={setWorkflowPromptTargets(selected, [])} disabled /></App>);
    expect(off).toContain("未映射提示词，使用右侧工作流字段值");
    expect(off).toContain("女人在跳舞");
});
