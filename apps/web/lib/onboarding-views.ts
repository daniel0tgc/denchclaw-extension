/**
 * Ensure on-disk projections (`.object.yaml`) exist for every onboarding
 * object, then install the default saved views the wizard promises.
 *
 * Runs from `sync-runner.ts` once backfill completes (idempotent — safe to
 * re-run; merges into any user-edited views without dropping them).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findObjectDir,
  getObjectViews,
  resolveWorkspaceRoot,
  saveObjectViews,
} from "./workspace";
import type { SavedView, SortRule } from "./object-filters";

// ---------------------------------------------------------------------------
// Object-dir bootstrapping
// ---------------------------------------------------------------------------

const ONBOARDING_OBJECT_DESCRIPTORS: Array<{
  name: string;
  description: string;
  icon: string;
  defaultView: SavedView["view_type"];
  fieldNames: string[];
}> = [
  {
    name: "email_thread",
    description: "Email thread synced from Gmail",
    icon: "messages-square",
    defaultView: "table",
    fieldNames: [
      "Subject",
      "Last Message At",
      "Message Count",
      "Participants",
      "Companies",
      "Gmail Thread ID",
    ],
  },
  {
    name: "email_message",
    description: "Single email message synced from Gmail",
    icon: "mail",
    defaultView: "table",
    fieldNames: [
      "Subject",
      "Sent At",
      "From",
      "To",
      "Cc",
      "Thread",
      "Body Preview",
      "Body",
      "Has Attachments",
      "Gmail Message ID",
    ],
  },
  {
    name: "calendar_event",
    description: "Calendar event synced from Google Calendar",
    icon: "calendar",
    defaultView: "calendar",
    fieldNames: [
      "Title",
      "Start At",
      "End At",
      "Organizer",
      "Attendees",
      "Companies",
      "Meeting Type",
      "Google Event ID",
    ],
  },
  {
    name: "interaction",
    description: "Email or meeting between you and a contact (used for ranking)",
    icon: "activity",
    defaultView: "timeline",
    fieldNames: [
      "Type",
      "Occurred At",
      "Person",
      "Company",
      "Email",
      "Event",
      "Direction",
      "Score Contribution",
    ],
  },
];

function generateObjectYaml(descriptor: (typeof ONBOARDING_OBJECT_DESCRIPTORS)[number]): string {
  const lines = [
    `name: "${descriptor.name}"`,
    `description: "${descriptor.description}"`,
    `icon: "${descriptor.icon}"`,
    `default_view: "${descriptor.defaultView}"`,
    "fields:",
  ];
  for (const fieldName of descriptor.fieldNames) {
    lines.push(`  - name: "${fieldName}"`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Make sure `<workspace>/<object>/.object.yaml` exists for each onboarding
 * object so `findObjectDir` resolves them and the workspace tree shows them.
 */
export function ensureOnboardingObjectDirs(): { created: string[] } {
  const root = resolveWorkspaceRoot();
  if (!root) {return { created: [] };}
  const created: string[] = [];
  for (const descriptor of ONBOARDING_OBJECT_DESCRIPTORS) {
    const objDir = join(root, descriptor.name);
    const yamlPath = join(objDir, ".object.yaml");
    if (existsSync(yamlPath)) {continue;}
    try {
      mkdirSync(objDir, { recursive: true });
      writeFileSync(yamlPath, generateObjectYaml(descriptor), "utf-8");
      created.push(descriptor.name);
    } catch {
      // ignore — object will be created on next attempt
    }
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Default saved views
// ---------------------------------------------------------------------------

function viewByName<T extends SavedView>(views: SavedView[], name: string): T | undefined {
  return views.find((view) => view.name === name) as T | undefined;
}

function upsertView(views: SavedView[], next: SavedView): SavedView[] {
  const filtered = views.filter((view) => view.name !== next.name);
  filtered.push(next);
  return filtered;
}

export type DefaultViewsResult = {
  installed: Array<{ object: string; view: string; created: boolean }>;
};

/**
 * Install (or refresh) the default saved views for the onboarding objects.
 * Existing views with the same `name` are replaced; any other user views
 * stay untouched.
 */
export function installDefaultViews(): DefaultViewsResult {
  const installed: DefaultViewsResult["installed"] = [];

  // ----- people · Strongest connections -----
  installPeopleStrongestView(installed);
  installPeopleGoingColdView(installed);
  installPeopleRecentlyAddedView(installed);

  // ----- company · By Strength -----
  installCompanyByStrengthView(installed);

  // ----- email_thread · Recent threads -----
  installEmailThreadRecentView(installed);

  // ----- email_message · Recent messages -----
  installEmailMessageRecentView(installed);

  return { installed };
}

function installPeopleStrongestView(out: DefaultViewsResult["installed"]): void {
  const dir = findObjectDir("people");
  if (!dir) {return;}
  const { views, viewSettings } = getObjectViews("people");
  const sort: SortRule[] = [
    { field: "Strength Score", direction: "desc" },
    { field: "Last Interaction At", direction: "desc" },
  ];
  const existing = viewByName(views, "Strongest");
  const next: SavedView = {
    name: "Strongest",
    view_type: "table",
    sort,
    columns: [
      "Full Name",
      "Email Address",
      "Company",
      "Strength Score",
      "Last Interaction At",
      "Source",
    ],
  };
  const updated = upsertView(views, next);
  saveObjectViews("people", updated, "Strongest", viewSettings);
  out.push({ object: "people", view: "Strongest", created: !existing });
}

function installPeopleGoingColdView(out: DefaultViewsResult["installed"]): void {
  const dir = findObjectDir("people");
  if (!dir) {return;}
  const { views, activeView, viewSettings } = getObjectViews("people");
  const existing = viewByName(views, "Going Cold");
  const next: SavedView = {
    name: "Going Cold",
    view_type: "table",
    sort: [{ field: "Last Interaction At", direction: "asc" }],
    filters: {
      id: "going-cold",
      conjunction: "and",
      rules: [
        {
          id: "strength-min",
          field: "Strength Score",
          operator: "gt",
          value: 5,
        },
        {
          id: "last-inter-cold",
          field: "Last Interaction At",
          operator: "before",
          // Static "60 days ago" snapshot at install time; the rule still
          // reads as "anyone we haven't talked to in the last 60+ days"
          // because Last Interaction At updates as new mail arrives.
          value: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    },
    columns: ["Full Name", "Company", "Strength Score", "Last Interaction At"],
  };
  const updated = upsertView(views, next);
  saveObjectViews("people", updated, activeView ?? "Strongest", viewSettings);
  out.push({ object: "people", view: "Going Cold", created: !existing });
}

/**
 * Replaces the legacy "Recently added" preset chip on the People list. The
 * preset used to live on `/api/crm/people?filter=recent` and sort by
 * `created_at DESC`; now that People renders through the unified ObjectView,
 * the same affordance is provided as a saved view that the user can pick
 * from the ObjectFilterBar.
 */
function installPeopleRecentlyAddedView(out: DefaultViewsResult["installed"]): void {
  const dir = findObjectDir("people");
  if (!dir) {return;}
  const { views, activeView, viewSettings } = getObjectViews("people");
  const existing = viewByName(views, "Recently Added");
  const next: SavedView = {
    name: "Recently Added",
    view_type: "table",
    sort: [{ field: "created_at", direction: "desc" }],
    columns: [
      "Full Name",
      "Email Address",
      "Company",
      "Strength Score",
      "Last Interaction At",
      "Source",
    ],
  };
  const updated = upsertView(views, next);
  saveObjectViews("people", updated, activeView ?? "Strongest", viewSettings);
  out.push({ object: "people", view: "Recently Added", created: !existing });
}

function installCompanyByStrengthView(out: DefaultViewsResult["installed"]): void {
  const dir = findObjectDir("company");
  if (!dir) {return;}
  const { views, viewSettings } = getObjectViews("company");
  const existing = viewByName(views, "By Strength");
  const next: SavedView = {
    name: "By Strength",
    view_type: "table",
    sort: [
      { field: "Strength Score", direction: "desc" },
      { field: "Last Interaction At", direction: "desc" },
    ],
    columns: [
      "Company Name",
      "Domain",
      "Industry",
      "Strength Score",
      "Last Interaction At",
      "Source",
    ],
  };
  const updated = upsertView(views, next);
  saveObjectViews("company", updated, "By Strength", viewSettings);
  out.push({ object: "company", view: "By Strength", created: !existing });
}

function installEmailThreadRecentView(out: DefaultViewsResult["installed"]): void {
  const dir = findObjectDir("email_thread");
  if (!dir) {return;}
  const { views, viewSettings } = getObjectViews("email_thread");
  const existing = viewByName(views, "Recent threads");
  const next: SavedView = {
    name: "Recent threads",
    view_type: "table",
    sort: [{ field: "Last Message At", direction: "desc" }],
    columns: ["Subject", "Last Message At", "Message Count", "Participants"],
  };
  const updated = upsertView(views, next);
  saveObjectViews("email_thread", updated, "Recent threads", viewSettings);
  out.push({ object: "email_thread", view: "Recent threads", created: !existing });
}

function installEmailMessageRecentView(out: DefaultViewsResult["installed"]): void {
  const dir = findObjectDir("email_message");
  if (!dir) {return;}
  const { views, viewSettings } = getObjectViews("email_message");
  const existing = viewByName(views, "Recent messages");
  const next: SavedView = {
    name: "Recent messages",
    view_type: "table",
    sort: [{ field: "Sent At", direction: "desc" }],
    columns: ["Sent At", "From", "Subject", "To", "Has Attachments"],
  };
  const updated = upsertView(views, next);
  saveObjectViews("email_message", updated, "Recent messages", viewSettings);
  out.push({ object: "email_message", view: "Recent messages", created: !existing });
}
