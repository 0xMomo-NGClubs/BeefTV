import { afterEach, expect, test } from "bun:test";
import type { GenerationOutput } from "@/lib/generation-outputs";
import { captureUserScope } from "@/lib/user-scope-guard";
import { getActiveUserScope, setActiveUserScope } from "@/lib/user-scope";
import { apiClient } from "@/services/api/request";
import { resolveCanvasGenerationOutputs } from "@/services/canvas-generation-outputs";

const adapter = apiClient.defaults.adapter;
const scope = getActiveUserScope();
afterEach(() => {
    apiClient.defaults.adapter = adapter;
    setActiveUserScope(scope);
});
const output: GenerationOutput = { id: "output:1", outputIndex: 1, mediaType: "video", dataUrl: "/api/resources/video/file", storageKey: "resource:video" };
const task = { id: "owned-task", status: "succeeded", resultJson: JSON.stringify({ outputs: [output] }), outputs: [{ outputIndex: 1, mediaType: "video", resourceId: "video", materializedAssetId: "owned-video-asset" }] };

test("result actions read canonical delivery through the shared task API and preserve cancellation", async () => {
    const controller = new AbortController();
    const expectedScope = captureUserScope();
    let requests = 0;
    apiClient.defaults.adapter = async (config) => {
        requests++;
        expect(config.url).toBe("/tasks/owned-task");
        expect(config.signal).toBe(controller.signal);
        return { data: { code: 0, data: task }, status: 200, statusText: "OK", headers: {}, config };
    };
    const [resolved] = await resolveCanvasGenerationOutputs(task.id, [{ ...output, assetId: "wrong-parent-asset" }], expectedScope, controller.signal);
    expect(resolved.assetId).toBe("owned-video-asset");
    expect(requests).toBe(1);
    controller.abort();
    await expect(resolveCanvasGenerationOutputs(task.id, [output], expectedScope, controller.signal)).rejects.toBeTruthy();
    expect(requests).toBe(1);
});

test("switching accounts A to B to A abandons the pending result action", async () => {
    const captured = captureUserScope();
    apiClient.defaults.adapter = async (config) => {
        setActiveUserScope("other-output-owner");
        setActiveUserScope(captured.userScope);
        return { data: { code: 0, data: task }, status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(resolveCanvasGenerationOutputs(task.id, [output], captured)).rejects.toMatchObject({ name: "UserScopeAbandonedError" });
});

test("a failed task query or mismatched task cannot produce a canvas output", async () => {
    apiClient.defaults.adapter = async (config) => ({ data: { code: 403, reason: "forbidden", msg: "not owned" }, status: 403, statusText: "Forbidden", headers: {}, config });
    await expect(resolveCanvasGenerationOutputs(task.id, [output], captureUserScope())).rejects.toThrow("not owned");
    apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data: { ...task, id: "other-task" } }, status: 200, statusText: "OK", headers: {}, config });
    await expect(resolveCanvasGenerationOutputs(task.id, [output], captureUserScope())).rejects.toThrow("任务不匹配");
});
