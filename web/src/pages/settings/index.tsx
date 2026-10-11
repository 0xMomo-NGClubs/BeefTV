import { App, Button } from "antd";
import { ArrowLeft, Bug, RadioTower, Workflow } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { ChannelSettingsPane, channelValidationError, focusInvalidChannelField, isChannelReady } from "./channel-settings-pane";
import { ModelDefaultGrid } from "./model-default-grid";
import DiagnosticsPanel from "./diagnostics-panel";
import { RunningHubSettingsPane } from "./runninghub-settings-pane";
import { isRunningHubReady } from "@/lib/generation-workflow-execution";
import { usePluginStore } from "@/stores/use-plugin-store";
import { flushModelConfig, getModelConfigPersistenceState } from "@/services/model-config-repository";

import { StorageSettingsPane } from "./storage-settings-pane";
import { ReferenceStoragePane } from "./reference-storage-pane";
import { getDesktopAppBinding } from "@/services/desktop-runtime";

type ConfigSectionKey = "channels" | "models" | "storage" | "diagnostics" | "runninghub";

const configSections: Array<{ key: ConfigSectionKey; label: string; description: string; icon: ReactNode }> = [
    { key: "channels", label: "个人渠道", description: "模型服务与个人工作流", icon: <RadioTower className="size-4" /> },
    { key: "runninghub", label: "RunningHub", description: "云端工作流与 App", icon: <Workflow className="size-4" /> },
    { key: "storage", label: "存储设置", description: "本地目录和参考素材存储", icon: null },
    { key: "diagnostics", label: "问题诊断", description: "导出问题记录", icon: <Bug className="size-4" /> },
];

export function isConfigSection(value: string | null): value is ConfigSectionKey {
    return configSections.some((section) => section.key === value);
}

export default function SettingsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedSection = searchParams.get("section");
    const customChannelsEnabled = useUserStore((state) => state.features.customChannelsEnabled);
    const initialSection = isConfigSection(requestedSection) ? requestedSection : "channels";
    const [activeTab, setActiveTab] = useState<ConfigSectionKey>(initialSection === "models" ? "channels" : initialSection);
    const config = useConfigStore((state) => state.config);
    const runtimeStatuses = usePluginStore((state) => state.runtimeStatuses);
    const [saving, setSaving] = useState(false);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = searchParams.get("continue") === "1";
    const userChannels = config.channels.filter((channel) => channel.scope !== "system");
    const nativeStorage = Boolean(getDesktopAppBinding()?.StorageSettings);
    const visibleConfigSections = useMemo(() => configSections.filter(section => ((section.key !== "channels" && section.key !== "runninghub") || customChannelsEnabled) && (section.key !== "storage" || nativeStorage)), [customChannelsEnabled, nativeStorage]);

    const isVisibleConfigSection = (value: string | null): value is ConfigSectionKey => isConfigSection(value) && visibleConfigSections.some((section) => section.key === value);

    useLayoutEffect(() => {
        document.body.classList.add("app-user-overlays");
        return () => document.body.classList.remove("app-user-overlays");
    }, []);

    useEffect(() => {
        if (isVisibleConfigSection(requestedSection)) {
            setActiveTab(requestedSection);
            return;
        }
        setActiveTab((current) => visibleConfigSections.some((section) => section.key === current) ? current : "channels");
    }, [customChannelsEnabled, requestedSection, visibleConfigSections]);

    const selectSection = (section: ConfigSectionKey) => {
        setActiveTab(section);
        const next = new URLSearchParams(searchParams);
        next.set("section", section);
        setSearchParams(next, { replace: true });
    };

    const finishConfig = async () => {
        const invalidChannel = customChannelsEnabled ? userChannels.find((channel) => channelValidationError(channel)) : undefined;
        if (invalidChannel) {
            selectSection("channels");
            message.warning(`${invalidChannel.name || "未命名渠道"}：${channelValidationError(invalidChannel)}`);
            focusInvalidChannelField(invalidChannel);
            return;
        }
        if (!effectiveConfig.channels.some(isChannelReady) && !(customChannelsEnabled && isRunningHubReady(config.runningHub, runtimeStatuses))) {
            selectSection("channels");
            message.error(customChannelsEnabled ? (shouldPromptContinue ? "请先完成至少一个渠道的 Base URL、API Key 和模型配置" : "当前没有可用渠道，请先完成连接信息和模型配置") : "当前没有可用的系统模型，请联系管理员配置系统渠道");
            return;
        }
        setSaving(true);
        try {
            await flushModelConfig();
            const persistence = getModelConfigPersistenceState();
            if (persistence.status === "error" || persistence.dirty) throw new Error(persistence.error || "配置尚未保存，请重试");
            message.success("配置已保存，正在返回创作页面");
            navigate(-1);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存配置失败");
        } finally {
            setSaving(false);
        }
    };

    const panes: Record<Exclude<ConfigSectionKey, "diagnostics">, ReactNode> = {
        runninghub: <SettingsPane><RunningHubSettingsPane /></SettingsPane>,
        channels: (
            <SettingsPane>
                <ChannelSettingsPane onOpenDiagnostics={() => selectSection("diagnostics")} onOpenRunningHub={() => selectSection("runninghub")} />
                <div className="settings-section model-default-section">
                    <div className="settings-pane-header">
                        <div className="min-w-0">
                            <h2>默认模型</h2>
                        </div>
                    </div>
                    <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} />
                </div>
            </SettingsPane>
        ),
        storage: <SettingsPane><StorageSettingsPane /><ReferenceStoragePane /></SettingsPane>,
        models: (
            <SettingsPane>
                <div className="settings-pane-header">
                    <div className="min-w-0">
                        <h2>模型选择</h2>
                        <p>按领域选择默认模型；模型能力与请求协议在渠道“模型与能力”中配置。</p>
                    </div>
                </div>
                <div className="settings-section">
                            <ModelDefaultGrid config={effectiveConfig} onChange={(key, model) => updateConfig(key, model)} onOpenChannels={customChannelsEnabled ? () => selectSection("channels") : undefined} />
                </div>
            </SettingsPane>
        ),
    };

    return (
        <main className="settings-page app-workspace-page app-user-workspace app-section-page flex h-full min-h-0 flex-col text-foreground">
            {nativeStorage ? <nav aria-label="设置栏目" className="flex shrink-0 flex-wrap gap-2 px-4 py-3">{visibleConfigSections.map(section=><Button key={section.key} aria-pressed={activeTab===section.key} onClick={()=>selectSection(section.key)}>{section.label}</Button>)}</nav> : null}
                {shouldPromptContinue || activeTab === "runninghub" ? <div className="settings-topbar shrink-0">
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        {activeTab === "runninghub" ? (
                            <Button icon={<ArrowLeft className="size-4" />} onClick={() => selectSection("channels")}>返回模型配置</Button>
                        ) : null}
                        {shouldPromptContinue ? <>
                        <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate(-1)}>返回创作</Button>
                        <Button type="primary" loading={saving} onClick={() => void finishConfig()}>保存并返回</Button>
                        </> : null}
                    </div>
                </div> : null}
            <div className="settings-library-frame flex min-h-0 flex-1 flex-col md:flex-row">
                <section className="settings-content flex min-h-0 min-w-0 flex-1 flex-col">
                    <div className="app-workspace-scroll app-section-page-content min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        <div className="settings-pane-root mx-auto w-full max-w-none">
                            {panes[activeTab === "diagnostics" ? "channels" : activeTab]}
                        </div>
                    </div>
                </section>
            </div>
            <DiagnosticsPanel
                open={activeTab === "diagnostics"}
                onClose={() => selectSection("channels")}
                taskId={searchParams.get("taskId") || undefined}
                projectId={searchParams.get("projectId") || undefined}
            />
        </main>
    );
}

function SettingsPane({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
    return <div className={fill ? "settings-pane h-full" : "settings-pane"}>{children}</div>;
}
