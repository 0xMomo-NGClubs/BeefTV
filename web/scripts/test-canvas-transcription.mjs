// Real React/Chrome interactions against mock local APIs; no paid model calls.
import { createServer } from "vite";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "transcription-test-page",
    configureServer(server) {
        server.middlewares.use("/__transcription_test", async (_req, res) => {
            const html = await server.transformIndexHtml("/__transcription_test", '<html><body><div id="root"></div><script type="module" src="/test/fixtures/canvas-transcription-runtime.tsx"></script></body></html>');
            res.setHeader("Content-Type", "text/html"); res.end(html);
        });
    },
}] });
let browser;
try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("Browser error:", error.message); });
    page.on("requestfailed", request => console.error("Failed request:", request.url(), request.failure()?.errorText));
    const submissions = [];
    let holdResult = false;
    const result = { segments: [{ startMs: 250, endMs: 1750, text: "你好，自动字幕" }], language: "zh" };
    await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith("/api/")) return route.continue();
        const envelope = data => route.fulfill({ json: { code: 0, data, msg: "ok" } });
        if (path === "/api/beefapi/connection/models") return envelope({ models: [
            { id: "hy-asr-3.0-preview", supportedEndpointTypes: ["audio.transcriptions"] },
            { id: "minimax-speech-2.8-hd", supportedEndpointTypes: ["audio.speech"] },
        ] });
        if (path === "/api/timeline/transcriptions") {
            submissions.push(route.request().postDataJSON());
            return envelope({ id: "transcription-fixture", status: "succeeded", resultJson: JSON.stringify(result) });
        }
        if (path === "/api/tasks/transcription-fixture") return envelope({ id: "transcription-fixture", status: holdResult ? "running" : "succeeded", stage: "正在转写", resultJson: JSON.stringify(result) });
        return route.fulfill({ status: 500, json: { code: 500, msg: `Unexpected test route ${path}` } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/__transcription_test`);
    await page.getByRole("button", { name: "读取 BeefTV 转写模型" }).click();
    await page.getByRole("combobox", { name: "转写模型" }).click();
    await page.getByText("hy-asr-3.0-preview · BeefTV", { exact: true }).last().click();
    assert.equal(await page.getByText("minimax-speech-2.8-hd", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "自动转写字幕" }).click();
    try { await page.getByText("已识别 1 条字幕，可编辑后保存或导出 SRT", { exact: true }).waitFor(); }
    catch (error) { console.error("Rendered state:", await page.locator("body").innerText(), "Submissions:", submissions); throw error; }
    const entries = JSON.parse(await page.getByTestId("subtitles").textContent());
    assert.deepEqual(entries, [{ startMs: 250, endMs: 1750, text: "你好，自动字幕", index: 1 }]);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].model, "hy-asr-3.0-preview");
    assert.equal(submissions[0].resourceId, "resource-fixture");
    assert.equal(submissions[0].projectId, "project-fixture");
    assert.ok(submissions[0].clientOperationId);
    holdResult = true;
    await page.getByRole("button", { name: "自动转写字幕" }).click();
    await page.getByText("关闭窗口后，转写任务仍会继续，可在任务中心查看。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭测试窗口" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="running"]')?.textContent === "false");
    result.segments[0].text = "关闭后不能写入";
    holdResult = false;
    await page.getByRole("button", { name: "重新打开" }).click();
    assert.equal(await page.getByRole("button", { name: "自动转写字幕" }).isEnabled(), true);
    assert.deepEqual(JSON.parse(await page.getByTestId("subtitles").textContent()), entries);
    assert.deepEqual(errors, []);
    console.log("PASS: cloud catalog selection, task submission, timed subtitle attachment, close resets UI without cancelling task or attaching late results; no paid requests");
} finally {
    await browser?.close();
    await server.close();
}
