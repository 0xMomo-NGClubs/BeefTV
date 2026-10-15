import { workflowFieldSafeToOverride, workflowFieldSource } from "@/lib/model-capabilities";
import type { RunningHubWorkflow, WorkflowFieldMapping, WorkflowInputTarget } from "@/stores/use-config-store";

export type WorkflowMediaKind = "image" | "video" | "audio";
export type WorkflowMediaCounts = Record<WorkflowMediaKind, number>;
type Graph = Record<string, unknown> | undefined;
type Node = { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } };

function graphNode(graph: Graph, id: string): Node | undefined {
    const value = graph?.[id];
    return value && typeof value === "object" && !Array.isArray(value) ? value as Node : undefined;
}

export function workflowMediaInputKind(field: WorkflowFieldMapping): WorkflowMediaKind | undefined {
    const source = workflowFieldSource(field);
    if (["referenceimage", "referenceimages", "image"].includes(source)) return "image";
    if (["referencevideo", "referencevideos", "video"].includes(source)) return "video";
    if (["referenceaudio", "referenceaudios", "audio"].includes(source)) return "audio";
}

export function workflowInputSlotIndex(field: WorkflowFieldMapping) {
    return Math.max(0, field.imageOrder && field.imageOrder > 0 ? field.imageOrder - 1 : field.sourceIndex || 0);
}

export function workflowInputTargetKey(target: WorkflowInputTarget) {
    return JSON.stringify([target.nodeId, target.inputName]);
}

export function workflowInputTargetLabel(target: WorkflowInputTarget, graph?: Graph) {
    const node = graphNode(graph, target.nodeId);
    return `${node?._meta?.title || target.targetClassType} · ${target.nodeId}.${target.inputName}`;
}

// Port 0 only: LoadImage's mask output must never become an image omission target.
export function workflowDirectInputTargets(graph: Graph, field: WorkflowFieldMapping): WorkflowInputTarget[] {
    const source = graphNode(graph, field.nodeId);
    if (!source?.class_type || !source.inputs || !["string", "number", "boolean"].includes(typeof source.inputs[field.fieldName])) return [];
    return Object.entries(graph || {}).flatMap(([nodeId]) => {
        const node = graphNode(graph, nodeId);
        if (!node?.class_type) return [];
        return Object.entries(node.inputs || {}).flatMap(([inputName, link]) =>
            Array.isArray(link) && link.length === 2 && String(link[0]) === field.nodeId && link[1] === 0
                ? [{ nodeId, inputName, sourceNodeId: field.nodeId, sourceOutputIndex: 0, sourceClassType: source.class_type!, targetClassType: node.class_type! }] : []);
    }).sort((a, b) => workflowInputTargetKey(a).localeCompare(workflowInputTargetKey(b)));
}

export function workflowRecommendedInputTargets(graph: Graph, field: WorkflowFieldMapping) {
    if (workflowMediaInputKind(field) !== "image" || field.fieldName !== "image" || graphNode(graph, field.nodeId)?.class_type !== "LoadImage") return [];
    return workflowDirectInputTargets(graph, field).filter((target) => /^reference_images\.reference_image_[0-9]+$/.test(target.inputName));
}

export function workflowMediaInputPolicy(workflow: RunningHubWorkflow | undefined, field: WorkflowFieldMapping) {
    const retain = { mode: "retain" as const, targets: [] as WorkflowInputTarget[], error: "" };
    if (!workflow || workflow.kind === "app" || field.enabled === false || field.required || !workflowFieldSafeToOverride(field) || !workflowMediaInputKind(field)) return retain;
    const mode = field.emptyInputMode || "inherit";
    if (mode === "retain") return retain;
    if (mode !== "inherit" && mode !== "disconnect") return { ...retain, error: "空素材策略无效，请重新选择" };
    if (mode === "inherit") {
        const targets = workflow.optionalImageMode === "retain" ? [] : workflowRecommendedInputTargets(workflow.workflowJson, field);
        return { ...retain, mode: targets.length ? "disconnect" as const : "retain" as const, targets };
    }
    const targets = field.emptyInputTargets || [];
    if (!targets.length) return { ...retain, error: "请选择空素材时要断开的目标输入" };
    const candidates = workflowDirectInputTargets(workflow.workflowJson, field);
    const invalid = targets.find((target) => !candidates.some((candidate) => workflowInputTargetKey(candidate) === workflowInputTargetKey(target)
        && candidate.sourceNodeId === target.sourceNodeId && candidate.sourceOutputIndex === target.sourceOutputIndex
        && candidate.sourceClassType === target.sourceClassType && candidate.targetClassType === target.targetClassType));
    if (invalid) return { ...retain, targets, error: `目标 ${invalid.nodeId}.${invalid.inputName} 已失效，请重新选择` };
    return { ...retain, mode: "disconnect" as const, targets };
}

export function workflowMediaInputPlan(workflow: RunningHubWorkflow | undefined, counts: WorkflowMediaCounts, fields = workflow?.fields || []) {
    const active = fields.filter((field) => field.enabled !== false && workflowMediaInputKind(field) && workflowFieldSafeToOverride(field));
    return active.map((field) => {
        const kind = workflowMediaInputKind(field)!;
        const slotIndex = workflowInputSlotIndex(field);
        const policy = workflowMediaInputPolicy(workflow, field);
        const shared = active.filter((candidate) => candidate.nodeId === field.nodeId).length > 1;
        const missing = slotIndex >= counts[kind];
        const error = policy.error || (missing && policy.mode === "disconnect" && shared ? "同一加载节点有多个素材字段，请先拆分映射" : "");
        const action = error ? "invalid" : !missing ? "provided" : field.required ? "required" : policy.mode;
        return { field, kind, slotIndex, action, targets: policy.targets, error };
    });
}

export function workflowEmptyMediaLabel(item: ReturnType<typeof workflowMediaInputPlan>[number]) {
    if (item.error) return item.error;
    if (item.action === "required") return "待连接素材（必填）";
    if (item.action === "provided") return "使用本次素材";
    if (item.action === "disconnect") return `不参与指定参考（断开 ${item.targets.length} 个输入）`;
    return "使用工作流默认素材";
}
