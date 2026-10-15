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
    const path = (target.path || []).map((step) => `${step.classType} ${step.nodeId}`).join(" → ");
    return `${path ? `${path} → ` : ""}${node?._meta?.title || target.targetClassType} · ${target.nodeId}.${target.inputName}`;
}

export function workflowInputTargetIdentity(target: WorkflowInputTarget) {
    return JSON.stringify([target.nodeId, target.inputName, target.sourceNodeId, target.sourceOutputIndex, target.sourceClassType, target.targetClassType,
        (target.path || []).map((step) => [step.nodeId, step.inputName, step.classType])]);
}

// Verified single-image transforms from ComfyUI nodes.py / nodes_images.py.
// Linked controls may depend on another material; do not cross those nodes.
const imageTransforms = new Set(["ImageScale", "ImageScaleBy", "ImageCrop", "ImageCropV2"]);

export function workflowInputTargetOptions(graph: Graph, field: WorkflowFieldMapping) {
    const targets: WorkflowInputTarget[] = [];
    const blocked = new Set<string>();
    const source = graphNode(graph, field.nodeId);
    if (!source?.class_type || !source.inputs || !["string", "number", "boolean"].includes(typeof source.inputs[field.fieldName])) return { targets, blocked: [] as string[] };
    const outgoing = new Map<string, Array<{ nodeId: string; inputName: string; node: Node }>>();
    for (const nodeId of Object.keys(graph || {}).sort()) {
        const node = graphNode(graph, nodeId);
        if (!node?.class_type) continue;
        for (const [inputName, link] of Object.entries(node.inputs || {}).sort(([a], [b]) => a.localeCompare(b))) {
            // Output 1 of LoadImage is a mask, never an image omission target.
            if (!Array.isArray(link) || link.length !== 2 || link[1] !== 0) continue;
            const id = String(link[0]);
            outgoing.set(id, [...(outgoing.get(id) || []), { nodeId, inputName, node }]);
        }
    }
    const follow = (sourceId: string, path: NonNullable<WorkflowInputTarget["path"]>, visited: Set<string>) => {
        for (const { nodeId, inputName, node } of outgoing.get(sourceId) || []) {
            if (visited.has(nodeId)) {
                blocked.add(`节点 ${nodeId} 存在循环路径，保留默认连线`);
                continue;
            }
            if (imageTransforms.has(node.class_type!)) {
                const linkedControl = Object.entries(node.inputs || {}).some(([name, value]) => name !== "image" && Array.isArray(value) && value.length === 2);
                if (path.length >= 64 || source.class_type !== "LoadImage" || field.fieldName !== "image" || workflowMediaInputKind(field) !== "image" || inputName !== "image" || linkedControl) {
                    blocked.add(`节点 ${nodeId}（${node.class_type}）含未确认的输入依赖，保留默认连线`);
                    continue;
                }
                follow(nodeId, [...path, { nodeId, inputName, classType: node.class_type! }], new Set([...visited, nodeId]));
                continue;
            }
            if (node.class_type === "ImageBatch") {
                blocked.add(`节点 ${nodeId}（ImageBatch）合并多份图片，保留默认连线`);
                continue;
            }
            targets.push({ nodeId, inputName, sourceNodeId: field.nodeId, sourceOutputIndex: 0, sourceClassType: source.class_type!, targetClassType: node.class_type!, ...(path.length ? { path } : {}) });
        }
    };
    follow(field.nodeId, [], new Set([field.nodeId]));
    return { targets: targets.sort((a, b) => workflowInputTargetKey(a).localeCompare(workflowInputTargetKey(b))), blocked: [...blocked] };
}

export function workflowRecommendedInputTargets(graph: Graph, field: WorkflowFieldMapping) {
    if (workflowMediaInputKind(field) !== "image" || field.fieldName !== "image" || graphNode(graph, field.nodeId)?.class_type !== "LoadImage") return [];
    return workflowInputTargetOptions(graph, field).targets.filter((target) => /^reference_images\.reference_image_[0-9]+$/.test(target.inputName));
}

export function workflowMediaInputPolicy(workflow: RunningHubWorkflow | undefined, field: WorkflowFieldMapping) {
    const retain = { mode: "retain" as const, targets: [] as WorkflowInputTarget[], error: "", notice: "" };
    if (!workflow || workflow.kind === "app" || field.enabled === false || field.required || !workflowFieldSafeToOverride(field) || !workflowMediaInputKind(field)) return retain;
    const mode = field.emptyInputMode || "inherit";
    if (mode === "retain") return retain;
    if (mode !== "inherit" && mode !== "disconnect") return { ...retain, error: "空素材策略无效，请重新选择" };
    if (mode === "inherit") {
        const targets = workflow.optionalImageMode === "retain" ? [] : workflowRecommendedInputTargets(workflow.workflowJson, field);
        const notice = workflow.optionalImageMode === "retain" ? "" : workflowInputTargetOptions(workflow.workflowJson, field).blocked.join("；");
        return { ...retain, mode: targets.length ? "disconnect" as const : "retain" as const, targets, notice };
    }
    const targets = field.emptyInputTargets || [];
    if (!targets.length) return { ...retain, error: "请选择空素材时要断开的目标输入" };
    const candidates = workflowInputTargetOptions(workflow.workflowJson, field).targets;
    const invalid = targets.find((target) => !candidates.some((candidate) => workflowInputTargetIdentity(candidate) === workflowInputTargetIdentity(target)));
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
        return { field, kind, slotIndex, action, targets: policy.targets, error, notice: policy.notice };
    });
}

export function workflowEmptyMediaLabel(item: ReturnType<typeof workflowMediaInputPlan>[number]) {
    if (item.error) return item.error;
    if (item.action === "required") return "待连接素材（必填）";
    if (item.action === "provided") return "使用本次素材";
    if (item.action === "disconnect") return `不参与指定参考（断开 ${item.targets.length} 个输入）`;
    return "使用工作流默认素材";
}
