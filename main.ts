import { App, Notice, Plugin } from 'obsidian';
import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';

const GITHUB_API_BASE = "https://api.github.com/repos";

interface GHSyncSettings {
    remoteURL: string;
    gitLocation: string;
    syncinterval: number;
    isSyncOnLoad: boolean;
    githubToken: string; // 新增 GitHub API Token
}

const DEFAULT_SETTINGS: GHSyncSettings = {
    remoteURL: '',
    gitLocation: '',
    syncinterval: 0,
    isSyncOnLoad: false,
    githubToken: '',
}

export default class GHSyncPlugin extends Plugin {
    settings: GHSyncSettings;

    async SyncNotes() {
        if (this.isMobile()) {
            await this.syncViaGitHubAPI();
        } else {
            await this.syncViaGit();
        }
    }

    isMobile(): boolean {
        return (this.app as any).isMobile;
    }

    async syncViaGit() {
        new Notice("Syncing via Git");
        const remote = this.settings.remoteURL;
        const git: SimpleGit = simpleGit({
            baseDir: this.app.vault.adapter.getBasePath(),
            binary: this.settings.gitLocation + "git",
        });
        
        try {
            await git.pull("origin", "main");
            await git.add(".");
            await git.commit("Auto-sync from Obsidian");
            await git.push("origin", "main");
            new Notice("Git sync complete");
        } catch (error) {
            new Notice("Git sync failed: " + error.message);
        }
    }

    async syncViaGitHubAPI() {
        new Notice("Syncing via GitHub API");
        const repo = this.settings.remoteURL.replace("https://github.com/", "");
        const headers = { 'Authorization': `token ${this.settings.githubToken}`, 'Accept': 'application/vnd.github.v3+json' };
        
        const files = this.app.vault.getFiles();
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const path = file.path;
            
            await fetch(`${GITHUB_API_BASE}/${repo}/contents/${path}`, {
                method: "PUT",
                headers: headers,
                body: JSON.stringify({
                    message: "Update from Obsidian mobile",
                    content: btoa(content),
                    branch: "main"
                })
            });
        }
        new Notice("GitHub API sync complete");
    }
}
