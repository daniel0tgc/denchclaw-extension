"use client";

import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PROMPT_SUGGESTIONS, type PromptSuggestion } from "@/lib/prompt-suggestions";

const VISIBLE_COUNT = 7;

function shuffleArray<T>(arr: T[]): T[] {
	const copy = [...arr];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function pickRandom(count: number): PromptSuggestion[] {
	return shuffleArray(PROMPT_SUGGESTIONS).slice(0, count);
}

function SuggestionPill({
	suggestion,
	onClick,
}: {
	suggestion: PromptSuggestion;
	onClick: (prompt: string) => void;
}) {
	const Icon = suggestion.icon;
	const isBrand = suggestion.iconType === "brand";

	return (
		<button
			type="button"
			onClick={() => onClick(suggestion.prompt)}
			className="group flex items-center gap-2.5 px-3.5 py-2.5 text-left rounded-xl transition-all duration-200 border shrink-0 hover:border-[var(--color-border-hover,var(--color-border))]"
			style={{
				background: "var(--color-surface)",
				borderColor: "var(--color-border)",
			}}
		>
			<div
				className={`flex-shrink-0 w-5 h-5 flex items-center justify-center transition-all duration-200 ${
					isBrand
						? "grayscale opacity-50 group-hover:grayscale-0 group-hover:opacity-100"
						: "opacity-45 group-hover:opacity-100"
				}`}
			>
				{isBrand ? (
					<Icon
						className="w-[18px] h-[18px]"
						style={{ color: suggestion.brandColor }}
					/>
				) : (
					<Icon className="w-[18px] h-[18px]" />
				)}
			</div>
			<div className="min-w-0 flex flex-col">
				<span
					className="text-xs font-medium leading-tight truncate"
					style={{ color: "var(--color-text)" }}
				>
					{suggestion.label}
				</span>
				<span
					className="text-[10.5px] leading-tight truncate mt-0.5"
					style={{ color: "var(--color-text-muted)" }}
				>
					{suggestion.subtitle}
				</span>
			</div>
		</button>
	);
}

export function HeroSuggestions({
	compact,
	onPromptClick,
}: {
	compact: boolean;
	onPromptClick: (prompt: string) => void;
}) {
	const [seed, setSeed] = useState(0);

	const visible = useMemo(
		() => pickRandom(VISIBLE_COUNT),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[seed],
	);

	const handleShuffle = useCallback(() => {
		setSeed((s) => s + 1);
	}, []);

	const row1Count = compact ? 4 : 3;
	const row1 = visible.slice(0, row1Count);
	const row2 = visible.slice(row1Count);

	return (
		<div
			className={`mt-4 md:mt-6 flex flex-col gap-2 md:gap-2.5 w-full max-w-[760px] mx-auto ${compact ? "px-2" : "px-4"}`}
		>
			<div className="flex items-center justify-center gap-2 flex-wrap">
				{row1.map((s) => (
					<SuggestionPill
						key={s.id}
						suggestion={s}
						onClick={onPromptClick}
					/>
				))}
			</div>
			<div className="flex items-center justify-center gap-2 flex-wrap">
				{row2.map((s) => (
					<SuggestionPill
						key={s.id}
						suggestion={s}
						onClick={onPromptClick}
					/>
				))}
				<button
					type="button"
					onClick={handleShuffle}
					className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200 border hover:border-[var(--color-border-hover,var(--color-border))]"
					style={{
						background: "var(--color-surface)",
						borderColor: "var(--color-border)",
						color: "var(--color-text-muted)",
					}}
					title="Shuffle suggestions"
				>
					<RefreshCw className="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
	);
}
