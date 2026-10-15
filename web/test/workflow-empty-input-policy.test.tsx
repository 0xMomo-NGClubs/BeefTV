import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowEmptyInputEditor } from "@/components/workflow-empty-input-editor";
import { WorkflowInputPlan } from "@/components/workflow-input-plan";
import { workflowInputTargetOptions, workflowMediaInputPlan, workflowMediaInputPolicy, workflowRecommendedInputTargets } from "@/lib/workflow-image-inputs";
import { mergeWorkflowFieldMappings, normalizeConfigSnapshot, normalizeWorkflowFieldMappings, defaultConfig, type RunningHubWorkflow } from "@/stores/use-config-store";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { usePluginStore } from "@/stores/use-plugin-store";

afterEach(() => usePluginStore.getState().setRuntimeStatuses({}));

function fixture(kind = "image"): RunningHubWorkflow {
    const classType = kind === "image" ? "LoadImage" : kind === "video" ? "VideoLoader" : "LoadAudio";
    return {
        workflowId: "flow", kind: "workflow", capability: "text", optionalImageMode: "retain",
        fields: [{ nodeId: "1", fieldName: kind, source: `reference${kind[0].toUpperCase()}${kind.slice(1)}`, enabled: true, required: false }],
        workflowJson: {
            "1": { class_type: classType, inputs: { [kind]: "default.file" } },
            "2": { class_type: "Generator", inputs: { optional_reference: ["1", 0], second_reference: ["1", 0], mask: ["1", 1], text: "keep" } },
            "3": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
        },
    };
}

function explicit(workflow = fixture()) {
    const field = workflow.fields![0];
    field.emptyInputMode = "disconnect";
    field.emptyInputTargets = workflowInputTargetOptions(workflow.workflowJson, field).targets.filter((target) => target.nodeId === "2");
    return workflow;
}

test.each(["image", "video", "audio"])("explicit %s policy targets multiple direct inputs and overrides global retain", (kind) => {
    const workflow = explicit(fixture(kind));
    const plan = workflowMediaInputPlan(workflow, { image: 0, video: 0, audio: 0 });
    expect(plan[0].action).toBe("disconnect");
    expect(plan[0].targets.map((target) => target.inputName)).toEqual(["optional_reference", "second_reference"]);
    expect(plan[0].targets.some((target) => target.inputName === "mask" || target.nodeId === "3")).toBe(false);
    expect(workflowMediaInputPlan(workflow, { image: 1, video: 1, audio: 1 })[0].action).toBe("provided");
    expect(workflowMediaInputPolicy({ ...workflow, kind: "app" }, workflow.fields![0]).targets).toEqual([]);
});

test("inherit only recommends the known dynamic IMAGE structure; per-field retain wins", () => {
    const workflow = fixture();
    const field = workflow.fields![0];
    expect(workflowRecommendedInputTargets(workflow.workflowJson, field)).toEqual([]);
    (workflow.workflowJson!["2"] as any).inputs["reference_images.reference_image_7"] = ["1", 0];
    workflow.optionalImageMode = "disconnect";
    expect(workflowMediaInputPolicy(workflow, field).targets).toHaveLength(1);
    expect(workflowMediaInputPolicy(workflow, { ...field, emptyInputMode: "retain" }).targets).toHaveLength(0);
    for (const patch of [{ required: true }, { enabled: false }, { safeToOverride: false }, { source: "mask" }]) {
        expect(workflowMediaInputPolicy(workflow, { ...field, ...patch }).targets).toHaveLength(0);
    }
});

test.each(["missing target", "different link", "target class", "source class", "mask output", "missing source"])("reparse preserves and invalidates pinned mapping: %s", (change) => {
    const workflow = explicit();
    const before = JSON.stringify(workflow.fields);
    const graph = workflow.workflowJson as Record<string, any>;
    if (change === "missing target") delete graph["2"];
    if (change === "different link") graph["2"].inputs.optional_reference = ["9", 0];
    if (change === "target class") graph["2"].class_type = "OtherGenerator";
    if (change === "source class") graph["1"].class_type = "OtherLoader";
    if (change === "mask output") graph["2"].inputs.optional_reference = ["1", 1];
    if (change === "missing source") delete graph["1"];
    expect(workflowMediaInputPolicy(workflow, workflow.fields![0]).error).toContain("已失效");
    const incoming = change === "missing source" ? [] : [{ nodeId: "1", fieldName: "image", fieldType: "IMAGE" }];
    const fields = mergeWorkflowFieldMappings(workflow.fields, incoming, "text");
    expect(fields[0].emptyInputTargets).toEqual(workflow.fields![0].emptyInputTargets);
    expect(JSON.stringify(workflow.fields)).toBe(before);
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, runningHub: { ...defaultConfig.runningHub, workflows: [{ ...workflow, fields }] } } }).config;
    const savedField = config.runningHub.workflows[0].fields!.find((field) => field.nodeId === "1" && field.fieldName === "image")!;
    expect(savedField.emptyInputTargets).toEqual(fields[0].emptyInputTargets);
    expect(workflowMediaInputPolicy(config.runningHub.workflows[0], savedField).error).toContain("已失效");
});

test("partial and non-contiguous slots use the actual uploaded count; shared loaders need explicit separation", () => {
    const workflow = explicit();
    workflow.fields![0].sourceIndex = 2;
    expect(workflowMediaInputPlan(workflow, { image: 2, video: 0, audio: 0 })[0].action).toBe("disconnect");
    expect(workflowMediaInputPlan(workflow, { image: 3, video: 0, audio: 0 })[0].action).toBe("provided");
    workflow.fields!.push({ ...workflow.fields![0], fieldName: "another_image", sourceIndex: 0, emptyInputMode: "retain" });
    expect(workflowMediaInputPlan(workflow, { image: 1, video: 0, audio: 0 })[0].error).toContain("多个素材字段");
});

test("configuration errors remain visible before submission, with direct target identities", () => {
    const workflow = explicit();
    const field = workflow.fields![0];
    const editor = renderToStaticMarkup(<WorkflowEmptyInputEditor field={field} workflowJson={workflow.workflowJson!} disabled={false} onChange={() => {}} />);
    expect(editor).toContain("没有素材时");
    expect(editor).toContain("2.optional_reference");
    const plan = renderToStaticMarkup(<WorkflowInputPlan workflow={workflow} counts={{ image: 0, video: 0, audio: 0 }} />);
    expect(plan).toContain("断开 1");
    expect(plan).toContain("断开 2 个输入");
    field.emptyInputTargets = [];
    expect(workflowMediaInputPolicy(workflow, field).error).toContain("请选择");
    expect(renderToStaticMarkup(<WorkflowInputPlan workflow={workflow} counts={{ image: 0, video: 0, audio: 0 }} />)).toContain("配置需确认");
});

test("pinned policies persist and reach task snapshots; invalid pins fail before task creation", async () => {
    usePluginStore.getState().setRuntimeStatuses({ "runninghub-workflow-provider": "enabled" });
    const workflow = explicit();
    const config = { ...defaultConfig, taskWorkflowProvider: "runninghub" as const, runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "test", capability: "text" as const, selectedKind: "workflow" as const, workflowId: "flow", workflows: [workflow] } };
    const task = await prepareBackendGenerationTask({ mode: "text", prompt: "", config });
    expect((task.input.config as any).workflowFields[0].emptyInputTargets).toEqual(workflow.fields![0].emptyInputTargets);
    workflow.fields![0].emptyInputTargets = [];
    await expect(prepareBackendGenerationTask({ mode: "text", prompt: "", config })).rejects.toThrow("请选择空素材");
});

test.each([{}, [null], [{ nodeId: "2", inputName: "optional_reference" }]])("malformed target metadata is retained as an actionable invalid configuration: %j", (emptyInputTargets) => {
    const workflow = explicit();
    workflow.fields = normalizeWorkflowFieldMappings([{ ...workflow.fields![0], emptyInputTargets }], "text");
    expect(workflowMediaInputPolicy(workflow, workflow.fields[0]).error).not.toBe("");
    expect(() => renderToStaticMarkup(<WorkflowEmptyInputEditor field={workflow.fields![0]} workflowJson={workflow.workflowJson!} disabled={false} onChange={() => {}} />)).not.toThrow();
});
