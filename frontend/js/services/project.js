/**
 * SLATE 项目服务：封装项目相关 API
 */

import { get, post, put } from "./api.js?v=20260922-005";

async function openProject(path) {
  return post("/projects/open", { path });
}

async function getCurrentProject() {
  return get("/projects/current");
}

async function closeProject() {
  return post("/projects/close");
}

async function updateProjectConfig(config) {
  return put("/projects/config", { config });
}

async function browseFiles(path = "") {
  return post("/projects/browse", { path });
}

async function listDrives() {
  return get("/projects/drives");
}

async function createWorkspace(name, folders) {
  return post("/projects/workspace", { name, folders });
}

async function switchProjectRoot(path) {
  return post("/projects/root", { path });
}

async function editWorkspaceFolders(action, path) {
  return post("/projects/workspace/folders", { action, path });
}

export {
  openProject, getCurrentProject, closeProject, updateProjectConfig,
  browseFiles, listDrives, createWorkspace, switchProjectRoot, editWorkspaceFolders,
};
