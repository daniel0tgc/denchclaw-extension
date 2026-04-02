"use client";

import { ChevronDown } from "lucide-react";
import {
	SiClaude,
	SiGoogle,
	SiMeta,
	SiMistralai,
	SiOpenai,
	SiPerplexity,
} from "react-icons/si";
import type { CSSProperties } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { ChatModelOption } from "@/lib/chat-models";

function ProviderIcon({
	model,
	className,
}: {
	model: ChatModelOption;
	className?: string;
}) {
	const normalized = model.provider.trim().toLowerCase();
	const iconStyle: CSSProperties = { color: "currentColor" };

	if (normalized === "minimax" || normalized === "mini-max") {
		return (
			<img
				src="/models/minimax.png"
				alt=""
				className={className}
				draggable={false}
				data-provider-icon="minimax"
			/>
		);
	}

	if (normalized === "deepseek") {
		return (
			<img
				src="/models/deepseek.ico"
				alt=""
				className={className}
				draggable={false}
				data-provider-icon="deepseek"
			/>
		);
	}

	if (
		normalized === "kimi" ||
		normalized === "moonshot" ||
		normalized === "moonshotai"
	) {
		return (
			<img
				src="/models/kimi.png"
				alt=""
				className={className}
				draggable={false}
				data-provider-icon="kimi"
			/>
		);
	}

	switch (normalized) {
		case "anthropic":
		case "claude":
			return (
				<SiClaude
					className={className}
					style={iconStyle}
					data-provider-icon="claude"
				/>
			);
		case "openai":
		case "chatgpt":
			return (
				<SiOpenai
					className={className}
					style={iconStyle}
					data-provider-icon="openai"
				/>
			);
		case "google":
			return (
				<SiGoogle
					className={className}
					style={{ color: "#4285F4" }}
					data-provider-icon="google"
				/>
			);
		case "meta":
			return (
				<SiMeta
					className={className}
					style={{ color: "#0668E1" }}
					data-provider-icon="meta"
				/>
			);
		case "mistral":
			return (
				<SiMistralai
					className={className}
					style={{ color: "#FF7000" }}
					data-provider-icon="mistral"
				/>
			);
		case "perplexity":
			return (
				<SiPerplexity
					className={className}
					style={{ color: "#20B8CD" }}
					data-provider-icon="perplexity"
				/>
			);
		default:
			return (
				<span
					className={className}
					style={{
						color: "var(--color-text-muted)",
						fontSize: "0.75rem",
						fontWeight: 600,
						lineHeight: 1,
					}}
					aria-hidden
					data-provider-icon="fallback"
				>
					{model.provider.slice(0, 1).toUpperCase()}
				</span>
			);
	}
}

export function ChatModelSelector({
	models,
	selectedModel,
	onSelect,
}: {
	models: ChatModelOption[];
	selectedModel: string | null;
	onSelect: (stableId: string) => void;
}) {
	const activeModel =
		models.find((model) => model.stableId === selectedModel) ?? models[0] ?? null;

	if (!activeModel) {
		return null;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className="inline-flex max-w-full items-center gap-1.5 rounded-lg p-0 text-sm font-medium transition-opacity hover:opacity-100"
				style={{ color: "var(--color-text-secondary)", opacity: 0.9 }}
				aria-label="Select chat model"
				title={activeModel.displayName}
			>
				<ProviderIcon
					model={activeModel}
					className="h-3.5 w-3.5 shrink-0"
				/>
				<span className="max-w-[240px] truncate">{activeModel.displayName}</span>
				<ChevronDown className="h-3.5 w-3.5 shrink-0" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side="bottom"
				sideOffset={8}
				className="min-w-[15rem] max-w-[18rem] p-1.5"
			>
				<DropdownMenuRadioGroup
					value={activeModel.stableId}
					onValueChange={onSelect}
				>
					{models.map((model) => (
						<DropdownMenuRadioItem key={model.stableId} value={model.stableId}>
							<ProviderIcon
								model={model}
								className="h-4 w-4 shrink-0"
							/>
							<div
								className="min-w-0 flex-1 truncate text-sm font-medium"
								style={{ color: "var(--color-text)" }}
							>
								{model.displayName}
							</div>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
