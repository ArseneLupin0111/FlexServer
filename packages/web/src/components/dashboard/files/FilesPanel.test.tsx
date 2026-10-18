import "../../../test/setup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FilesPanel } from "./FilesPanel";
import type { VpsRecord } from "../../../lib/api";
import * as filesApi from "../../../lib/files-api";

vi.mock("../../../lib/files-api", () => ({
  createDirectory: vi.fn(),
  deleteEntry: vi.fn(),
  downloadFile: vi.fn(),
  getFilesCapabilities: vi.fn(),
  listFilesEntries: vi.fn(),
  renameEntry: vi.fn(),
  uploadFile: vi.fn(),
}));

const vps: VpsRecord = {
  id: "vps-a", name: "server-a", host: "127.0.0.1", port: 22,
  username: "operator", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", sftpEnabled: true,
};
const capabilities: filesApi.FilesCapabilities = {
  enabled: true, available: true, transport: "local", reason: null,
};
const file: filesApi.FileEntry = {
  name: "report.txt", path: "/report.txt", type: "file", size: 4,
  modifiedAt: null, mode: 0o644,
};

function renderPanel(record = vps) {
  return render(<MemoryRouter><FilesPanel vps={record} /></MemoryRouter>);
}

function stubListing(entries: filesApi.FileEntry[]) {
  vi.mocked(filesApi.getFilesCapabilities).mockResolvedValue(capabilities);
  vi.mocked(filesApi.listFilesEntries).mockResolvedValue({ path: "/", entries });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FilesPanel behavior", () => {
  it("does not display VPS A entries while VPS B capabilities are pending", async () => {
    let resolveCaps!: (value: filesApi.FilesCapabilities) => void;
    vi.mocked(filesApi.getFilesCapabilities)
      .mockResolvedValueOnce(capabilities)
      .mockReturnValueOnce(new Promise((resolve) => { resolveCaps = resolve; }));
    vi.mocked(filesApi.listFilesEntries).mockResolvedValue({ path: "/", entries: [file] });
    const { rerender } = renderPanel();
    expect(await screen.findByText("report.txt")).toBeInTheDocument();

    rerender(<MemoryRouter><FilesPanel vps={{ ...vps, id: "vps-b", name: "server-b" }} /></MemoryRouter>);
    expect(screen.queryByText("report.txt")).not.toBeInTheDocument();
    resolveCaps({ ...capabilities, available: false });
    await waitFor(() => expect(filesApi.listFilesEntries).toHaveBeenCalledTimes(1));
  });

  it("cancels an active upload and reports cancellation accessibly", async () => {
    stubListing([]);
    let rejectUpload!: (reason: Error) => void;
    vi.mocked(filesApi.uploadFile).mockImplementation(() => new Promise((_, reject) => { rejectUpload = reject; }));
    renderPanel();
    await screen.findByText("Directory is empty.");

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const upload = new File([new Uint8Array([1, 2, 3])], "payload.bin");
    fireEvent.change(input, { target: { files: [upload] } });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Uploading payload.bin");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rejectUpload(Object.assign(new Error("Upload cancelled"), { name: "FilesApiError", code: "ABORTED" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload cancelled");
  });

  it("keeps deletion confirmation cancellable without mutating the entry", async () => {
    stubListing([file]);
    renderPanel();
    await screen.findByText("report.txt");
    fireEvent.click(screen.getByRole("button", { name: "Delete report.txt" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(filesApi.deleteEntry).not.toHaveBeenCalled();
  });

  it("shows disabled direct-route state without requesting capabilities", () => {
    renderPanel({ ...vps, sftpEnabled: false });
    expect(screen.getByText("Files & SFTP is disabled")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Configure in Settings" })).toHaveAttribute("href", "/vps/vps-a/settings");
    expect(filesApi.getFilesCapabilities).not.toHaveBeenCalled();
  });
});
