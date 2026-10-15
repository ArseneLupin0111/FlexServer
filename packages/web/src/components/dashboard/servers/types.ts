import { type FormEvent, type ReactNode } from "react";
import type { DashboardOverview, UpdateVpsPayload, VpsRecord } from "../../../lib/api";

export type ViewMode = "card" | "table";

export type CreateFormType = {
  name: string;
  displayName: string;
  host: string;
  port: string;
  username: string;
  password: string;
};

export type ServersPanelProps = {
  records: VpsRecord[];
  visibleRecords: VpsRecord[];
  statusMessage: ReactNode;
  serverSearch: string;
  statusFilter: string;
  busy: boolean;
  mode: "demo" | "local";
  provisionPasswords: Record<string, string>;
  createForm: CreateFormType;
  metrics: DashboardOverview["metrics"];
  systemInfo: DashboardOverview["systemInfo"];
  dockerMetrics: DashboardOverview["dockerMetrics"];
  jobs: DashboardOverview["jobs"];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onCreateFormChange: (value: CreateFormType) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onPasswordChange: (id: string, value: string) => void;
  onProvision: (vps: VpsRecord) => void;
  onVerify: (vps: VpsRecord) => void;
  onInstallAgent: (vps: VpsRecord) => void;
  onUninstallAgent: (vps: VpsRecord) => void;
  onRestartAgent: (vps: VpsRecord) => void;
  onRotateAgent: (vps: VpsRecord) => void;
  onEdit: (vps: VpsRecord, payload: UpdateVpsPayload) => Promise<void>;
  onDelete: (vps: VpsRecord) => void;
};
