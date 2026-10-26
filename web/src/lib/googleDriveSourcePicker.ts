'use client';

import {
  isScatterGoogleDriveOrigin,
  requestGoogleDriveSourceAccessToken,
} from '@/sync/providers/googleDrive';

const PICKER_SCRIPT = 'https://apis.google.com/js/api.js';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
// Google Picker browser keys are public identifiers. This key is restricted
// in Google Cloud to the Picker API and Scatter's canonical/local origins.
// Deployments on other origins must supply their own restricted key.
const SCATTER_GOOGLE_PICKER_API_KEY = 'AIzaSyApmZe4ZqTOnRHdMl-p2WavT2L1VLE9kIw';
const SCATTER_GOOGLE_DRIVE_APP_ID = '992714113012';

export interface GoogleDrivePickerConfiguration {
  developerKey: string;
  appId: string;
}

export function resolveGoogleDrivePickerConfiguration(
  configuredKey: string | undefined,
  configuredAppId: string | undefined,
  origin: string,
): GoogleDrivePickerConfiguration | null {
  const developerKey = configuredKey?.trim();
  if (developerKey) {
    return {
      developerKey,
      appId: configuredAppId?.trim() ?? '',
    };
  }
  if (!isScatterGoogleDriveOrigin(origin)) return null;
  return {
    developerKey: SCATTER_GOOGLE_PICKER_API_KEY,
    appId: SCATTER_GOOGLE_DRIVE_APP_ID,
  };
}

export interface GoogleDriveSourceSelection {
  id: string;
  name: string;
  mimeType: string;
}

export interface GoogleDriveSourcePickerOptions {
  onSelected?: (files: readonly GoogleDriveSourceSelection[]) => void;
}

interface PickerDocument {
  id?: string;
  name?: string;
  mimeType?: string;
}

interface PickerResponse {
  action?: string;
  docs?: PickerDocument[];
}

interface PickerApi {
  Action: { PICKED: string; CANCEL: string };
  Feature: { MULTISELECT_ENABLED: string };
  ViewId: { DOCS: string };
  DocsView: new (viewId: string) => {
    setIncludeFolders(value: boolean): unknown;
    setSelectFolderEnabled(value: boolean): unknown;
    setMimeTypes(value: string): unknown;
  };
  PickerBuilder: new () => {
    addView(view: unknown): unknown;
    enableFeature(feature: string): unknown;
    setOAuthToken(token: string): unknown;
    setDeveloperKey(key: string): unknown;
    setAppId(id: string): unknown;
    setCallback(callback: (data: PickerResponse) => void): unknown;
    build(): { setVisible(visible: boolean): void };
  };
}

declare global {
  interface Window {
    gapi?: { load(name: string, callback: { callback: () => void; onerror: () => void }): void };
  }
}

function pickerApi(): PickerApi | null {
  return ((window.google as unknown as { picker?: PickerApi } | undefined)?.picker) ?? null;
}

async function loadPicker(): Promise<PickerApi> {
  if (!window.gapi) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${PICKER_SCRIPT}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Could not load Google Picker.')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = PICKER_SCRIPT;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Google Picker.'));
      document.head.appendChild(script);
    });
  }
  await new Promise<void>((resolve, reject) => {
    window.gapi!.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Picker did not initialize.')) });
  });
  const api = pickerApi();
  if (!api) throw new Error('Google Picker did not initialize.');
  return api;
}

async function chooseFiles(token: string, developerKey: string, appId: string): Promise<GoogleDriveSourceSelection[]> {
  const picker = await loadPicker();
  const view = new picker.DocsView(picker.ViewId.DOCS);
  view.setIncludeFolders(false);
  view.setSelectFolderEnabled(false);
  view.setMimeTypes([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/markdown', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.presentation',
  ].join(','));
  return new Promise((resolve, reject) => {
    const built = new picker.PickerBuilder();
    built.addView(view);
    built.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    built.setOAuthToken(token);
    built.setDeveloperKey(developerKey);
    if (appId) built.setAppId(appId);
    built.setCallback((data) => {
      if (data.action === picker.Action.CANCEL) resolve([]);
      if (data.action !== picker.Action.PICKED) return;
      const files = (data.docs ?? []).flatMap((doc) => (
        doc.id && doc.name && doc.mimeType
          ? [{ id: doc.id, name: doc.name, mimeType: doc.mimeType }]
          : []
      ));
      resolve(files);
    });
    try { built.build().setVisible(true); } catch (error) { reject(error); }
  });
}

async function downloadDriveFile(file: GoogleDriveSourceSelection, token: string): Promise<File> {
  let url = `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`;
  let name = file.name;
  let mimeType = file.mimeType;
  if (file.mimeType === 'application/vnd.google-apps.document') {
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    url = `${DRIVE_API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(mimeType)}`;
    if (!name.toLocaleLowerCase().endsWith('.docx')) name += '.docx';
  } else if (file.mimeType === 'application/vnd.google-apps.presentation') {
    mimeType = 'application/pdf';
    url = `${DRIVE_API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(mimeType)}`;
    if (!name.toLocaleLowerCase().endsWith('.pdf')) name += '.pdf';
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not download “${file.name}” from Google Drive (${response.status}).`);
  return new File([await response.blob()], name, { type: mimeType, lastModified: Date.now() });
}

/** Opens Google Picker with drive.file scope and returns only the explicitly
 * selected files. No Drive token or file remains persisted by this helper. */
export async function pickGoogleDriveSourceFiles(
  options: GoogleDriveSourcePickerOptions = {},
): Promise<File[]> {
  const configuration = resolveGoogleDrivePickerConfiguration(
    process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY,
    process.env.NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID,
    window.location.origin,
  );
  if (!configuration) {
    throw new Error('Google Drive source import is not configured for this self-hosted origin.');
  }
  const token = await requestGoogleDriveSourceAccessToken();
  const selected = await chooseFiles(token, configuration.developerKey, configuration.appId);
  options.onSelected?.(selected);
  return Promise.all(selected.map((file) => downloadDriveFile(file, token)));
}
