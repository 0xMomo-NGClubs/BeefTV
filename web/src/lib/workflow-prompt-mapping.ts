import { workflowFieldKey, workflowFieldSafeToOverride, workflowFieldSource, type WorkflowVideoFieldLike } from "@/lib/model-capabilities";
import type { WorkflowFieldMapping } from "@/stores/use-config-store";

type PromptField = WorkflowVideoFieldLike & { bindPrompt?: boolean };

function bindsPrompt(field: PromptField) {
    const source = workflowFieldSource(field);
    return ["prompt", "text", "positiveprompt", "positive"].includes(source) || (!source && field.bindPrompt === true);
}

export function workflowPromptTargets<T extends PromptField>(fields: readonly T[], includeDisabled = false) {
    return fields.filter((field) => bindsPrompt(field) && workflowFieldSafeToOverride(field) && (includeDisabled || field.enabled !== false));
}

export function workflowPromptFieldOptions(fields: readonly PromptField[]) {
    return fields.filter((field) => {
        if (!field.nodeId || !field.fieldName || !workflowFieldSafeToOverride(field)) return false;
        const type = String(field.fieldType || "").trim().toUpperCase();
        const value = field.fieldValue ?? field.value ?? field.defaultValue ?? field.default;
        return bindsPrompt(field) || ["TEXT", "STRING", "MULTILINE"].includes(type) || (!type && (value == null || typeof value === "string"));
    }).map((field) => ({ value: workflowFieldKey(field), label: `${field.label || field.fieldName} · ${field.nodeId}.${field.fieldName}` }));
}

export function setWorkflowPromptTargets(fields: WorkflowFieldMapping[], keys: readonly string[]) {
    const allowed = new Set(workflowPromptFieldOptions(fields).map((option) => option.value));
    const selected = new Set(keys.filter((key) => allowed.has(key)));
    return fields.map((field) => {
        if (selected.has(workflowFieldKey(field))) return { ...field, source: "prompt", bindPrompt: false, sourceAutomatic: false, sourceFromUpstream: false, enabled: true, randomEnabled: false };
        if (bindsPrompt(field)) return { ...field, source: "", bindPrompt: false, sourceAutomatic: false, sourceFromUpstream: false, required: false, enabled: workflowFieldSafeToOverride(field) };
        return field;
    });
}

export function setWorkflowPromptEnabled(fields: WorkflowFieldMapping[], enabled: boolean) {
    return fields.map((field) => bindsPrompt(field) && workflowFieldSafeToOverride(field) ? { ...field, enabled } : field);
}

export function workflowPromptTargetLabel(fields: readonly PromptField[]) {
    return workflowPromptTargets(fields).map((field) => `${field.label || field.fieldName}（${field.nodeId}.${field.fieldName}）`).join("、");
}
