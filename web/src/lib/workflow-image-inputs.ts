import { workflowFieldKey, workflowFieldSource, type WorkflowVideoFieldLike } from "@/lib/model-capabilities";
import type { RunningHubWorkflow, WorkflowFieldMapping } from "@/stores/use-config-store";

// Preview the backend's narrowly supported dynamic IMAGE ports. Never imply that
// an arbitrary fixed input can be removed without its node schema.
export function disconnectedWorkflowImageFields(workflow: RunningHubWorkflow | undefined, fields: (WorkflowVideoFieldLike & { required?: boolean })[] = workflow?.fields || []): Set<string> {
    if (!workflow || workflow.kind === "app" || workflow.optionalImageMode === "retain") return new Set();
    const sourceNodes = new Set<string>();
    for (const raw of Object.values(workflow.workflowJson || {})) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const inputs = (raw as { inputs?: Record<string, unknown> }).inputs;
        for (const [name, link] of Object.entries(inputs || {})) {
            if (/^reference_images\.reference_image_[0-9]+$/.test(name) && Array.isArray(link) && link.length === 2 && link[1] === 0) sourceNodes.add(String(link[0]));
        }
    }
    return new Set(fields.filter((field) => {
        if (!field.nodeId || field.enabled === false || field.required || field.safeToOverride === false || !sourceNodes.has(field.nodeId)) return false;
        const source = workflowFieldSource(field);
        const node = workflow.workflowJson?.[field.nodeId] as { class_type?: string; inputs?: Record<string, unknown> } | undefined;
        return ["referenceimage", "referenceimages", "image"].includes(source) && field.fieldName === "image" && node?.class_type === "LoadImage" && !Array.isArray(node.inputs?.image);
    }).map(workflowFieldKey));
}

export function workflowEmptyImageLabel(field: WorkflowFieldMapping, disconnected: Set<string>) {
    return disconnected.has(workflowFieldKey(field)) ? "本次不参与参考" : "使用工作流默认值";
}
