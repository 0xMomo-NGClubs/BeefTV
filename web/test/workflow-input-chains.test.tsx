import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import fixture from "../../backend/internal/provider/workflow/testdata/media-input-chains.json";
import { WorkflowEmptyInputEditor } from "@/components/workflow-empty-input-editor";
import { WorkflowInputPlan } from "@/components/workflow-input-plan";
import { workflowInputTargetOptions, workflowMediaInputPlan, workflowMediaInputPolicy, workflowRecommendedInputTargets } from "@/lib/workflow-image-inputs";
import { defaultConfig, mergeWorkflowFieldMappings, normalizeConfigSnapshot, type RunningHubWorkflow, type WorkflowInputTarget } from "@/stores/use-config-store";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { usePluginStore } from "@/stores/use-plugin-store";

afterEach(() => usePluginStore.getState().setRuntimeStatuses({}));

function workflow(): RunningHubWorkflow {
    return { kind: "workflow", workflowId: "fixture", capability: "text", workflowJson: structuredClone(fixture.graph), fields: [structuredClone(fixture.field)] };
}

function explicit() {
    const flow = workflow();
    flow.fields![0] = { ...flow.fields![0], emptyInputMode: "disconnect", emptyInputTargets: structuredClone(fixture.targets) };
    return flow;
}

test("verified resize/crop paths share one fixture with backend; masks, merges and linked controls are not crossed", () => {
    const flow = workflow();
    const before = JSON.stringify(flow);
    expect(workflowRecommendedInputTargets(flow.workflowJson, flow.fields![0])).toEqual(fixture.targets);
    const options = workflowInputTargetOptions(flow.workflowJson, flow.fields![0]);
    expect(options.targets.map(({ nodeId, inputName }) => `${nodeId}.${inputName}`)).toEqual([
        "20.reference_images.reference_image_0", "20.reference_images.reference_image_1", "21.images", "31.image",
    ]);
    expect(options.blocked.join(" ")).toContain("ImageBatch");
    expect(options.blocked.join(" ")).toContain("40");
    expect(JSON.stringify(flow)).toBe(before);
    const plan = workflowMediaInputPlan(flow, { image: 1, audio: 0, video: 0 });
    expect(plan[0].action).toBe("disconnect");
    expect(plan[0].notice).toContain("合并多份图片");
    expect(workflowMediaInputPlan(flow, { image: 2, audio: 0, video: 0 })[0].action).toBe("provided");
});

test.each(["class", "rewired", "mask", "missing", "linked control", "cycle", "path pin", "path order", "root kind"])("a saved chain becomes invalid when %s changes, even with supplied media", (change) => {
    const flow = explicit();
    const graph = flow.workflowJson as Record<string, any>;
    if (change === "class") graph["10"].class_type = "OtherScale";
    if (change === "rewired") graph["11"].inputs.image = ["2", 0];
    if (change === "mask") graph["10"].inputs.image = ["1", 1];
    if (change === "missing") delete graph["10"];
    if (change === "linked control") graph["10"].inputs.width = ["41", 0];
    if (change === "cycle") graph["10"].inputs.image = ["11", 0];
    if (change === "path pin") flow.fields![0].emptyInputTargets![0].path![0].inputName = "width";
    if (change === "path order") flow.fields![0].emptyInputTargets![0].path!.reverse();
    if (change === "root kind") flow.fields![0].source = "referenceVideo";
    expect(workflowMediaInputPolicy(flow, flow.fields![0]).error).toContain("已失效");
    expect(workflowMediaInputPlan(flow, { image: 2, audio: 0, video: 2 })[0].action).toBe("invalid");
});

test("paths persist through reparse, normalization and task snapshots; invalid paths stop creation", async () => {
    const flow = explicit();
    flow.fields = mergeWorkflowFieldMappings(flow.fields, [{ ...fixture.field, fieldType: "IMAGE" }], "text");
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, taskWorkflowProvider: "runninghub", runningHub: { ...defaultConfig.runningHub, enabled: true, apiKey: "test", workflowId: "fixture", selectedKind: "workflow", capability: "text", workflows: [flow] } } }).config;
    expect(config.runningHub.workflows[0].fields![0].emptyInputTargets).toEqual(fixture.targets);
    usePluginStore.getState().setRuntimeStatuses({ "runninghub-workflow-provider": "enabled" });
    config.taskWorkflowProvider = "runninghub";
    const task = await prepareBackendGenerationTask({ mode: "text", prompt: "", config });
    expect((task.input.config as any).workflowFields[0].emptyInputTargets).toEqual(fixture.targets);
    (config.runningHub.workflows[0].workflowJson!["10"] as any).inputs.image = ["2", 0];
    await expect(prepareBackendGenerationTask({ mode: "text", prompt: "", config })).rejects.toThrow("已失效");
});

test.each([null, {}, [null], [{ nodeId: "10" }]])("malformed path %j remains visibly invalid", (path) => {
    const flow = explicit();
    (flow.fields![0].emptyInputTargets![0] as any).path = path;
    const config = normalizeConfigSnapshot({ config: { ...defaultConfig, runningHub: { ...defaultConfig.runningHub, workflows: [flow] } } }).config;
    const saved = config.runningHub.workflows[0];
    expect(workflowMediaInputPolicy(saved, saved.fields![0]).error).toContain("已失效");
});

test("editor and shared input plan display the full selected path and retained branch reasons", () => {
    const flow = explicit();
    const editor = renderToStaticMarkup(<WorkflowEmptyInputEditor field={flow.fields![0]} workflowJson={flow.workflowJson!} disabled={false} onChange={() => {}} />);
    expect(editor).toContain("ImageScale 10 → ImageCrop 11 →");
    expect(editor).toContain("最终输入");
    expect(editor).toContain("合并多份图片");
    const plan = renderToStaticMarkup(<WorkflowInputPlan workflow={workflow()} counts={{ image: 1, audio: 0, video: 0 }} />);
    expect(plan).toContain("ImageScale 10 → ImageCrop 11 →");
    expect(plan).toContain("保留默认连线");
});

test("fabricated paths cannot cross a merge or an unknown custom node", () => {
    const flow = explicit();
    for (const [nodeId, classType, inputName] of [["30", "ImageBatch", "image1"], ["31", "CustomResize", "image"]]) {
        const fake: WorkflowInputTarget = { ...fixture.targets[0], inputName: `reference_images.reference_image_${nodeId === "30" ? 3 : 4}`, path: [{ nodeId, classType, inputName }] };
        flow.fields![0].emptyInputTargets = [fake];
        expect(workflowMediaInputPolicy(flow, flow.fields![0]).error).toContain("已失效");
    }
});
