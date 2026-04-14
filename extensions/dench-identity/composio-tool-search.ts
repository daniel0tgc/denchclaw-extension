import type {
  ComposioToolCatalogFile,
  ComposioToolIndexFile,
  ComposioToolSummary,
} from "./composio-cheat-sheet.js";

export type ComposioToolSearchResult = {
  toolkit_slug: string;
  toolkit_name: string;
  tool: ComposioToolSummary;
  source: "featured" | "catalog" | "recipe";
  recipe_intents: string[];
  score: number;
  why_matched: string[];
};

export type ComposioToolSearchResponse = {
  results: ComposioToolSearchResult[];
  top_confidence: "high" | "medium" | "low";
};

type SearchDocument = {
  toolkit_slug: string;
  toolkit_name: string;
  tool: ComposioToolSummary;
  source: "featured" | "catalog" | "recipe";
  recipe_intents: string[];
  weightedTokens: string[];
  fieldTokens: Record<string, string[]>;
};

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FIELD_WEIGHTS: Record<string, number> = {
  tool_name: 6,
  title: 4,
  recipe: 5,
  example: 3,
  app: 2,
  description: 2,
  required_args: 2,
  arg_hints: 1,
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

function normalizeAppFilter(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function repeatTokens(tokens: string[], weight: number): string[] {
  if (tokens.length === 0 || weight <= 1) {
    return [...tokens];
  }
  const out: string[] = [];
  for (const token of tokens) {
    for (let i = 0; i < weight; i += 1) {
      out.push(token);
    }
  }
  return out;
}

function mergeToolSummary(
  catalogTool: ComposioToolSummary | undefined,
  featuredTool: ComposioToolSummary | undefined,
): { tool: ComposioToolSummary; source: "featured" | "catalog" } | null {
  if (!catalogTool && !featuredTool) {
    return null;
  }
  if (catalogTool && featuredTool) {
    return {
      source: "featured",
      tool: {
        ...catalogTool,
        ...featuredTool,
        required_args: featuredTool.required_args.length > 0
          ? featuredTool.required_args
          : catalogTool.required_args,
        arg_hints: Object.keys(featuredTool.arg_hints).length > 0
          ? featuredTool.arg_hints
          : catalogTool.arg_hints,
        default_args: featuredTool.default_args ?? catalogTool.default_args,
        example_args: featuredTool.example_args ?? catalogTool.example_args,
        example_prompts: featuredTool.example_prompts?.length
          ? featuredTool.example_prompts
          : catalogTool.example_prompts,
        input_schema: featuredTool.input_schema ?? catalogTool.input_schema,
      },
    };
  }
  if (featuredTool) {
    return { tool: featuredTool, source: "featured" };
  }
  return { tool: catalogTool as ComposioToolSummary, source: "catalog" };
}

function buildSyntheticRecipeTool(
  toolkitName: string,
  toolName: string,
  recipeIntents: string[],
): ComposioToolSummary {
  const primaryIntent = recipeIntents[0] ?? toolName;
  return {
    name: toolName,
    title: primaryIntent,
    description_short: `Recommended ${toolkitName} tool for ${primaryIntent}.`,
    required_args: [],
    arg_hints: {},
    example_prompts: recipeIntents,
  };
}

function buildSearchDocuments(
  index: ComposioToolIndexFile,
  catalog: ComposioToolCatalogFile | null,
  appFilter: string | null,
): SearchDocument[] {
  const catalogBySlug = new Map(
    (catalog?.connected_apps ?? []).map((app) => [app.toolkit_slug.toLowerCase(), app]),
  );
  const docs: SearchDocument[] = [];

  for (const app of index.connected_apps) {
    const normalizedApp = app.toolkit_slug.toLowerCase();
    if (appFilter && normalizedApp !== appFilter && app.toolkit_name.toLowerCase() !== appFilter) {
      continue;
    }

    const featuredByName = new Map(app.tools.map((tool) => [tool.name, tool]));
    const recipeIntentsByTool = new Map<string, string[]>();
    for (const [intent, toolName] of Object.entries(app.recipes)) {
      const bucket = recipeIntentsByTool.get(toolName);
      if (bucket) {
        bucket.push(intent);
      } else {
        recipeIntentsByTool.set(toolName, [intent]);
      }
    }

    const catalogApp = catalogBySlug.get(normalizedApp);
    const catalogByName = new Map((catalogApp?.tools ?? []).map((tool) => [tool.name, tool]));
    const allToolNames = new Set([
      ...featuredByName.keys(),
      ...catalogByName.keys(),
      ...recipeIntentsByTool.keys(),
    ]);

    for (const toolName of allToolNames) {
      const recipeIntents = recipeIntentsByTool.get(toolName) ?? [];
      const merged = mergeToolSummary(catalogByName.get(toolName), featuredByName.get(toolName));
      const source = merged?.source ?? "recipe";
      const tool = merged?.tool ?? buildSyntheticRecipeTool(app.toolkit_name, toolName, recipeIntents);

      const fieldTokens: Record<string, string[]> = {
        tool_name: tokenize(tool.name),
        title: tokenize(tool.title),
        recipe: tokenize(recipeIntents.join(" ")),
        example: tokenize((tool.example_prompts ?? []).join(" ")),
        app: tokenize(`${app.toolkit_slug} ${app.toolkit_name}`),
        description: tokenize(tool.description_short),
        required_args: tokenize(tool.required_args.join(" ")),
        arg_hints: tokenize([
          ...Object.keys(tool.arg_hints),
          ...Object.values(tool.arg_hints),
        ].join(" ")),
      };

      const weightedTokens = Object.entries(fieldTokens).flatMap(([field, tokens]) =>
        repeatTokens(tokens, FIELD_WEIGHTS[field] ?? 1)
      );

      docs.push({
        toolkit_slug: app.toolkit_slug,
        toolkit_name: app.toolkit_name,
        tool,
        source,
        recipe_intents: recipeIntents,
        weightedTokens,
        fieldTokens,
      });
    }
  }

  return docs;
}

function bm25Score(
  queryTokens: string[],
  documentTokens: string[],
  avgDocLength: number,
  totalDocs: number,
  documentFrequency: Map<string, number>,
): number {
  if (queryTokens.length === 0 || documentTokens.length === 0 || totalDocs === 0) {
    return 0;
  }

  const tf = new Map<string, number>();
  for (const token of documentTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  const docLength = documentTokens.length;
  let score = 0;
  for (const token of queryTokens) {
    const frequency = tf.get(token) ?? 0;
    if (frequency === 0) {
      continue;
    }
    const df = documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + ((totalDocs - df + 0.5) / (df + 0.5)));
    const numerator = frequency * (BM25_K1 + 1);
    const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
    score += idf * (numerator / denominator);
  }

  return score;
}

function matchedFields(queryTokens: string[], fieldTokens: Record<string, string[]>): string[] {
  const querySet = new Set(queryTokens);
  const matched = Object.entries(fieldTokens)
    .filter(([, tokens]) => tokens.some((token) => querySet.has(token)))
    .map(([field]) => field.replace(/_/g, " "));
  return matched.length > 0 ? matched : ["catalog"];
}

function topConfidence(scores: number[]): "high" | "medium" | "low" {
  const first = scores[0] ?? 0;
  const second = scores[1] ?? 0;
  if (first <= 0) {
    return "low";
  }
  if (second <= 0) {
    return "high";
  }
  const ratio = first / Math.max(second, 0.0001);
  if (ratio >= 1.5) {
    return "high";
  }
  if (ratio >= 1.15) {
    return "medium";
  }
  return "low";
}

export function searchComposioTools(params: {
  index: ComposioToolIndexFile;
  catalog: ComposioToolCatalogFile | null;
  query: string;
  app?: string;
  topK?: number;
}): ComposioToolSearchResponse {
  const queryTokens = tokenize(params.query);
  if (queryTokens.length === 0) {
    return { results: [], top_confidence: "low" };
  }

  const documents = buildSearchDocuments(
    params.index,
    params.catalog,
    normalizeAppFilter(params.app),
  );
  if (documents.length === 0) {
    return { results: [], top_confidence: "low" };
  }

  const avgDocLength = documents.reduce((sum, doc) => sum + doc.weightedTokens.length, 0)
    / Math.max(documents.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set(doc.weightedTokens);
    for (const token of seen) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const scored = documents
    .map((doc) => ({
      doc,
      score: bm25Score(
        queryTokens,
        doc.weightedTokens,
        avgDocLength || 1,
        documents.length,
        documentFrequency,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.doc.tool.name.localeCompare(right.doc.tool.name);
    });

  const topK = Math.max(1, Math.min(params.topK ?? 5, 10));
  const results = scored.slice(0, topK).map(({ doc, score }) => ({
    toolkit_slug: doc.toolkit_slug,
    toolkit_name: doc.toolkit_name,
    tool: doc.tool,
    source: doc.source,
    recipe_intents: doc.recipe_intents,
    score,
    why_matched: matchedFields(queryTokens, doc.fieldTokens),
  }));

  return {
    results,
    top_confidence: topConfidence(scored.slice(0, 2).map((entry) => entry.score)),
  };
}
