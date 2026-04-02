export type ChatModelOption = {
	stableId: string;
	displayName: string;
	provider: string;
	reasoning: boolean;
};

export function normalizeDenchModelId(
	model: string | null | undefined,
): string | null {
	if (typeof model !== "string" || !model.trim()) {
		return null;
	}
	const normalized = model.trim();
	return normalized.startsWith("dench-cloud/")
		? normalized.slice("dench-cloud/".length)
		: normalized;
}

export function isLikelyOpenAiModelId(
	model: string | null | undefined,
): boolean {
	const normalized = normalizeDenchModelId(model)?.toLowerCase() ?? "";
	return (
		normalized.startsWith("gpt-") ||
		normalized.startsWith("chatgpt") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.includes("openai")
	);
}

export function resolveActiveChatModelId({
	modelOverride,
	sessionModel,
	selectedDenchModel,
	models,
}: {
	modelOverride: string | null;
	sessionModel: string | null;
	selectedDenchModel: string | null;
	models: ChatModelOption[];
}): string | null {
	return (
		modelOverride ??
		normalizeDenchModelId(sessionModel) ??
		selectedDenchModel ??
		models[0]?.stableId ??
		null
	);
}

export function shouldMitigateOpenAiSwitch({
	sessionModel,
	sessionModelProvider,
	targetModel,
}: {
	sessionModel: string | null | undefined;
	sessionModelProvider: string | null | undefined;
	targetModel: string | null | undefined;
}): boolean {
	if (!isLikelyOpenAiModelId(targetModel)) {
		return false;
	}

	const provider = sessionModelProvider?.trim().toLowerCase();
	if (provider) {
		return provider !== "openai";
	}

	const currentModel = normalizeDenchModelId(sessionModel);
	if (!currentModel) {
		return false;
	}

	return !isLikelyOpenAiModelId(currentModel);
}
