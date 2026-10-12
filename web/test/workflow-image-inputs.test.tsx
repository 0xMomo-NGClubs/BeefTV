import { afterEach, expect, test } from "bun:test";
import { disconnectedWorkflowImageFields, workflowEmptyImageLabel } from "@/lib/workflow-image-inputs";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { defaultConfig, normalizeConfigSnapshot, type RunningHubWorkflow } from "@/stores/use-config-store";
import { usePluginStore } from "@/stores/use-plugin-store";
import { workflowFieldKey } from "@/lib/model-capabilities";

afterEach(() => usePluginStore.getState().setRuntimeStatuses({}));

const workflow: RunningHubWorkflow = {
    kind: "workflow", workflowId: "flow", capability: "text",
    fields: [
        { nodeId: "20", fieldName: "image", source: "referenceImage", sourceIndex: 0, enabled: true, required: true },
        { nodeId: "25", fieldName: "image", source: "referenceImage", sourceIndex: 1, enabled: true },
    ],
    workflowJson: {
        "20": { class_type: "LoadImage", inputs: { image: "first.png" } },
        "25": { class_type: "LoadImage", inputs: { image: "other.png" } },
        "21": { class_type: "MiniMaxH3PromptEnhancerT8", inputs: { "reference_images.reference_image_0": ["20", 0], "reference_images.reference_image_1": ["25", 0] } },
    },
};

test("empty dynamic image slots describe the actual omission policy; fixed, required and disabled slots keep defaults", () => {
    const optional = workflow.fields![1];
    const disconnected = disconnectedWorkflowImageFields(workflow);
    expect(disconnected.has(workflowFieldKey(optional))).toBe(true);
    expect(workflowEmptyImageLabel(optional, disconnected)).toBe("本次不参与参考");
    expect(disconnected.has(workflowFieldKey(workflow.fields![0]))).toBe(false);
    expect(disconnectedWorkflowImageFields({ ...workflow, optionalImageMode: "retain" }).size).toBe(0);
    expect(disconnectedWorkflowImageFields({ ...workflow, kind: "app" }).size).toBe(0);
    expect(disconnectedWorkflowImageFields({ ...workflow, fields: [{ ...optional, enabled: false }] }).size).toBe(0);
    expect(disconnectedWorkflowImageFields({ ...workflow, workflowJson: { ...workflow.workflowJson, "21": { inputs: { image: ["25", 0], "reference_images.reference_image_1": ["25", 1] } } } }).size).toBe(0);
});

test("image strategy persists through config normalization and reaches the backend for Workflow only", async () => {
    const runningHub = { ...defaultConfig.runningHub, enabled: true, apiKey: "test", workflowId: "flow", selectedKind: "workflow" as const, capability: "text" as const, workflows: [workflow] };
    usePluginStore.getState().setRuntimeStatuses({ "runninghub-workflow-provider": "enabled" });
    for (const policy of ["disconnect", "retain"] as const) {
        const config = normalizeConfigSnapshot({ config: { ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub: { ...runningHub, workflows: [{ ...workflow, optionalImageMode: policy }] } } }).config;
        expect(config.runningHub.workflows[0].optionalImageMode).toBe(policy);
        const task = await prepareBackendGenerationTask({ mode: "text", prompt: "hello", config: { ...config, taskWorkflowProvider: "runninghub" } });
        expect((task.input.config as Record<string, unknown>).optionalImageMode).toBe(policy);
    }
    const task = await prepareBackendGenerationTask({ mode: "text", prompt: "hello", config: { ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub: { ...runningHub, selectedKind: "app", workflows: [{ ...workflow, kind: "app" }] } } });
    expect((task.input.config as Record<string, unknown>).optionalImageMode).toBe("retain");
});
