import { localForageStorageForScope } from "@/lib/localforage-storage";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";
import { listGenerationTasks, queryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { ApiError } from "@/services/api/request";

export type WorkflowTestIdentity = { workflowId: string; kind: "workflow" | "app"; capability: "text" | "image" | "video" | "audio" };

export function matchesWorkflowTestTask(task: GenerationTask, identity: WorkflowTestIdentity) {
    if (task.provider !== "runninghub" || task.type !== `canvas_${identity.capability}`) return false;
    if (task.clientContext?.source === "workflow_settings_test") {
        return task.clientContext.workflowId === identity.workflowId && task.clientContext.workflowKind === identity.kind;
    }
    if (!task.inputJson) return false;
    try {
        const input = JSON.parse(task.inputJson);
        const config = input.config || {};
        const kind = config.webappId ? "app" : input.metadata?.workflowKind || "workflow";
        return input.metadata?.source === "workflow_settings_test" && kind === identity.kind && String(config.webappId || config.workflowId || input.metadata?.workflowId || "") === identity.workflowId;
    } catch {
        return false;
    }
}

function storageKey(identity: WorkflowTestIdentity) {
    return `workflow-test-task:${identity.kind}:${identity.capability}:${identity.workflowId}`;
}

export async function rememberWorkflowTestTask(identity: WorkflowTestIdentity, taskId: string) {
    if (!taskId.trim() || !identity.workflowId.trim()) throw new Error("缺少工作流任务标识");
    const scope = captureUserScope();
    await localForageStorageForScope(scope.userScope).setItem(storageKey(identity), taskId);
    assertUserScope(scope);
}

type LookupDependencies = {
    readId: (key: string) => Promise<string | null>;
    queryTask: typeof queryGenerationTask;
    listTasks: typeof listGenerationTasks;
};

export async function latestWorkflowTestTask(identity: WorkflowTestIdentity, signal?: AbortSignal, dependencies?: LookupDependencies) {
    if (!identity.workflowId.trim()) return null;
    const scope = captureUserScope();
    const deps = dependencies || { readId: (key: string) => Promise.resolve(localForageStorageForScope(scope.userScope).getItem(key)), queryTask: queryGenerationTask, listTasks: listGenerationTasks };
    const id = await deps.readId(storageKey(identity));
    assertUserScope(scope);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (id) {
        try {
            const task = await deps.queryTask(id, { signal, expectedScope: scope });
            assertUserScope(scope);
            if (matchesWorkflowTestTask(task, identity)) return task;
        } catch (error) {
            assertUserScope(scope);
            if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
    }
    const tasks = await deps.listTasks(100, undefined, undefined, signal);
    assertUserScope(scope);
    const summary = tasks.find((task) => matchesWorkflowTestTask(task, identity));
    if (!summary) return null;
    const task = await deps.queryTask(summary.id, { signal, expectedScope: scope });
    assertUserScope(scope);
    return matchesWorkflowTestTask(task, identity) ? task : null;
}
