export type Kind = 'asset' | 'scene' | 'dashboard'
export type ModelKind = 'asset' | 'scene'
export type Role = 'admin' | 'editor' | 'viewer'
export interface User { id: string; username: string; displayName: string; role: Role }
export interface Category { id: string; kind: Kind; name: string; parentId: string | null }
export interface Version { id: string; recordId: string; number: number; originalName: string; size: number; note: string; createdAt: string; uploadedBy: string; hasThumbnail: boolean; sourceKind: 'glb' | 'html' | 'zip' | 'folder'; entry: string | null }
export interface ModelRecord { id: string; kind: Kind; name: string; description: string; tags: string[]; categoryId: string | null; currentVersionId: string; revision: number; archived: boolean; createdAt: string; updatedAt: string; currentVersion: Version }
export interface Detail { record: ModelRecord; versions: Version[] }
export interface DashboardPackage { entry: string; files: { path: string; mime: string; base64: string }[] }
export interface DashboardManifest { entry: string; files: { path: string; size: number }[] }
