export function workflowTextOutputOptions(workflowJson?: Record<string, unknown>) {
    return Object.entries(workflowJson || {}).flatMap(([nodeId, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const node = value as { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } };
        if (!node.class_type || !node.inputs) return [];
        const name = typeof node.inputs.output_name === "string" ? node.inputs.output_name : node._meta?.title || node.class_type;
        return [{ value: nodeId, label: `${name} · 节点 ${nodeId}`, publishedText: node.class_type === "ShellAgentPluginOutputText" }];
    }).sort((a, b) => Number(b.publishedText) - Number(a.publishedText) || a.value.localeCompare(b.value, undefined, { numeric: true }));
}

export function defaultWorkflowTextOutputNodeId(workflowJson?: Record<string, unknown>) {
    const outputs = workflowTextOutputOptions(workflowJson).filter((item) => item.publishedText);
    return outputs.length === 1 ? outputs[0].value : undefined;
}
