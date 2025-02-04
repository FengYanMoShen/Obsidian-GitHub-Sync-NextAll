import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	Vault
} from 'obsidian';
import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';

// 如果未创建，请在项目根目录下创建 custom.d.ts，并加入下面两行声明：
//
// declare module 'isomorphic-git';
// declare module 'isomorphic-git/http/web';
//
import * as isogit from 'isomorphic-git';
import http from 'isomorphic-git/http/web';

// 判断是否为手机端（示例写法，根据实际情况修改）
const isMobile = (typeof navigator !== 'undefined') && /Android|iPhone|iPad/i.test(navigator.userAgent);

let simpleGitOptions: Partial<SimpleGitOptions>;
let git: SimpleGit;

interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	// 手机端认证设置（通过 HTTPS 认证用）
	githubUsername: string;
	githubToken: string;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	syncinterval: 0,
	isSyncOnLoad: false,
	githubUsername: '',
	githubToken: ''
};

export default class GHSyncPlugin extends Plugin {
	settings: GHSyncSettings;

	// 桌面端同步函数（依旧使用 simple-git）
	async SyncNotes() {
		new Notice("Syncing to GitHub remote (Desktop)");

		const remote = this.settings.remoteURL;
		// 使用类型断言获取 baseDir
		const baseDir = (this.app.vault.adapter as any).getBasePath();

		simpleGitOptions = {
			baseDir: baseDir,
			binary: this.settings.gitLocation + "git",
			maxConcurrentProcesses: 6,
			trimmed: false,
		};
		git = simpleGit(simpleGitOptions);

		// 使用 Node 的 os 模块获取主机名
		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => {
			new Notice("Vault is not a Git repo or git binary cannot be found.", 10000);
			return;
		});

		//@ts-ignore
		let clean = statusResult?.isClean ? statusResult.isClean() : false;

		let date = new Date();
		let msg = hostname + " " +
			date.getFullYear() + "-" + (date.getMonth() + 1) + "-" +
			date.getDate() + " " +
			date.getHours() + ":" + date.getMinutes() + ":" +
			date.getSeconds();

		// 如果工作区有改动，则执行 add 和 commit
		if (!clean) {
			try {
				await git
					.add("./*")
					.commit(msg);
			} catch (e) {
				new Notice(e);
				return;
			}
		} else {
			new Notice("Working branch clean");
		}

		// 配置远程仓库
		try {
			await git.removeRemote('origin').catch((e) => { new Notice(e); });
			await git.addRemote('origin', remote).catch((e) => { new Notice(e); });
		} catch (e) {
			new Notice(e);
			return;
		}

		// 检查远程 URL 是否有效
		try {
			await git.fetch();
		} catch (e) {
			new Notice(e + "\nGitHub Sync: Invalid remote URL.", 10000);
			return;
		}

		new Notice("GitHub Sync: Successfully set remote origin url");

		// 拉取远程更新
		try {
			//@ts-ignore
			await git.pull('origin', 'main', { '--no-rebase': null }, (err, update) => {
				if (update) {
					new Notice("GitHub Sync: Pulled " + update.summary.changes + " changes");
				}
			});
		} catch (e) {
			new Notice("Pull failed: " + e);
			return;
		}

		// 如果有改动，则推送
		if (!clean) {
			try {
				await git.push('origin', 'main', ['-u']);
				new Notice("GitHub Sync: Pushed on " + msg);
			} catch (e) {
				new Notice("Push failed: " + e, 10000);
			}
		}
	}

	// 手机端同步函数（使用 isomorphic‑git 实现）
	async SyncNotesMobile() {
		new Notice("Syncing to GitHub remote (Mobile)");
		const remote = this.settings.remoteURL;
		// 同样使用类型断言获取 baseDir
		const baseDir = (this.app.vault.adapter as any).getBasePath();
		const hostname = "MobileDevice";
		const date = new Date();
		const msg = hostname + " " +
			date.getFullYear() + "-" + (date.getMonth() + 1) + "-" +
			date.getDate() + " " +
			date.getHours() + ":" + date.getMinutes() + ":" +
			date.getSeconds();

		// 构造一个简单的 fs 适配器，将 Obsidian 的 Vault Adapter 封装为 fs 接口
		const fs = new ObsidianFS(this.app.vault.adapter);

		// 如果仓库未初始化，则先初始化 .git 目录
		try {
			await fs.exists(`${baseDir}/.git`).then(async exists => {
				if (!exists) {
					await isogit.init({ fs, dir: baseDir });
				}
			});
		} catch (e) {
			new Notice("Git init error: " + e);
			return;
		}

		// 检查工作区状态
		let statusMatrix;
		try {
			statusMatrix = await isogit.statusMatrix({ fs, dir: baseDir });
		} catch (e) {
			new Notice("Status error: " + e);
			return;
		}

		// 定义 statusMatrix 每一行的类型：[filepath, head, workdir, stage]
		type StatusRow = [string, number, number, number];
		let changesExist = (statusMatrix as StatusRow[]).some((row: StatusRow) => {
			return row[1] !== row[2];
		});

		// 若存在更改，则执行 add 和 commit
		if (changesExist) {
			for (const row of statusMatrix as StatusRow[]) {
				const filepath = row[0];
				try {
					await isogit.add({ fs, dir: baseDir, filepath });
				} catch (e) {
					// 忽略某些文件的 add 错误
				}
			}
			try {
				await isogit.commit({
					fs,
					dir: baseDir,
					message: msg,
					author: { name: hostname, email: "noreply@example.com" }
				});
			} catch (e) {
				new Notice("Commit error: " + e);
				return;
			}
		} else {
			new Notice("Working branch clean");
		}

		// 配置远程仓库（注意 isomorphic‑git 不支持动态删除远程，此处假定首次添加即可）
		try {
			await isogit.addRemote({ fs, dir: baseDir, remote: 'origin', url: remote });
		} catch (e) {
			// 如果远程已存在，忽略错误
		}

		// 使用 onAuth 回调传入设置页中的 GitHub 用户名和 token
		try {
			await isogit.fetch({
				fs,
				http,
				dir: baseDir,
				remote: 'origin',
				ref: 'main',
				singleBranch: true,
				tags: false,
				onAuth: () => ({
					username: this.settings.githubUsername,
					password: this.settings.githubToken
				})
			});
			new Notice("GitHub Sync: Successfully set remote origin url");
		} catch (e) {
			new Notice("Fetch error: " + e);
			return;
		}

		try {
			await isogit.pull({
				fs,
				http,
				dir: baseDir,
				remote: 'origin',
				ref: 'main',
				singleBranch: true,
				author: { name: hostname, email: "noreply@example.com" },
				onAuth: () => ({
					username: this.settings.githubUsername,
					password: this.settings.githubToken
				})
			});
		} catch (e) {
			new Notice("Pull failed: " + e);
			return;
		}

		// 若有更改，则推送更新
		if (changesExist) {
			try {
				await isogit.push({
					fs,
					http,
					dir: baseDir,
					remote: 'origin',
					ref: 'main',
					onAuth: () => ({
						username: this.settings.githubUsername,
						password: this.settings.githubToken
					})
				});
				new Notice("GitHub Sync: Pushed on " + msg);
			} catch (e) {
				new Notice("Push failed: " + e);
			}
		}
	}

	async onload() {
		await this.loadSettings();

		// 添加侧边栏图标，点击时根据平台调用不同同步函数
		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			if (isMobile) {
				this.SyncNotesMobile();
			} else {
				this.SyncNotes();
			}
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		// 注册命令
		this.addCommand({
			id: 'github-sync-command',
			name: 'Sync with Remote',
			callback: () => {
				if (isMobile) {
					this.SyncNotesMobile();
				} else {
					this.SyncNotes();
				}
			}
		});

		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		// 自动同步（根据设置的时间间隔，单位为分钟）
		if (!isNaN(this.settings.syncinterval)) {
			let interval: number = this.settings.syncinterval;
			if (interval >= 1) {
				try {
					setIntervalAsync(async () => {
						if (isMobile) {
							await this.SyncNotesMobile();
						} else {
							await this.SyncNotes();
						}
					}, interval * 60 * 1000);
					new Notice("Auto sync enabled");
				} catch (e) { }
			}
		}

		// 开启时检查远程更新（桌面端逻辑）
		try {
			simpleGitOptions = {
				baseDir: (this.app.vault.adapter as any).getBasePath(),
				binary: this.settings.gitLocation + "git",
				maxConcurrentProcesses: 6,
				trimmed: false,
			};
			git = simpleGit(simpleGitOptions);
			await git.branch({ '--set-upstream-to': 'origin/main' });
			let statusUponOpening = await git.fetch().status();
			if (statusUponOpening.behind > 0) {
				if (this.settings.isSyncOnLoad == true) {
					this.SyncNotes();
				} else {
					new Notice("GitHub Sync: " + statusUponOpening.behind + " commits behind remote.\nClick the GitHub ribbon icon to sync.");
				}
			} else {
				new Notice("GitHub Sync: up to date with remote.");
			}
		} catch (e) {
			// 忽略错误
		}
	}

	onunload() { }

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// 一个简单的 Obsidian Vault -> fs 适配器，仅实现部分方法（如 readFile、writeFile、readdir 等）
class ObsidianFS {
	adapter: any;
	constructor(adapter: any) {
		this.adapter = adapter;
	}
	// 读取文件，返回 Uint8Array
	async readFile(filepath: string): Promise<Uint8Array> {
		const data = await this.adapter.read(filepath);
		return new TextEncoder().encode(data);
	}
	// 写入文件（支持 string 或 Uint8Array）
	async writeFile(filepath: string, data: Uint8Array | string): Promise<void> {
		if (data instanceof Uint8Array) {
			data = new TextDecoder().decode(data);
		}
		await this.adapter.write(filepath, data);
	}
	// 读取目录列表
	async readdir(dirpath: string): Promise<string[]> {
		return await this.adapter.list(dirpath);
	}
	// 创建文件夹
	async mkdir(dirpath: string): Promise<void> {
		await this.adapter.createFolder(dirpath);
	}
	// 检查文件或目录是否存在
	async exists(filepath: string): Promise<boolean> {
		try {
			return await this.adapter.exists(filepath);
		} catch (e) {
			return false;
		}
	}
	// 简单的 stat 实现
	async stat(filepath: string): Promise<{ isFile: () => boolean, isDirectory: () => boolean }> {
		const exists = await this.exists(filepath);
		if (exists) {
			return { isFile: () => true, isDirectory: () => false };
		} else {
			throw new Error("File does not exist");
		}
	}
	// 删除文件
	async unlink(filepath: string): Promise<void> {
		await this.adapter.delete(filepath);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;
	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: "Paste your GitHub repo HTTPS or SSH URL here. For mobile sync using HTTPS, also fill in your GitHub username and a personal access token with appropriate repo permissions.", cls: "howto_text" });
		howto.createEl("br");
		const linkEl = howto.createEl('p');
		linkEl.createEl('span', { text: 'See the ' });
		linkEl.createEl('a', { href: 'https://github.com/kevinmkchin/Obsidian-GitHub-Sync/blob/main/README.md', text: 'README' });
		linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('[OPTIONAL] git binary location (Desktop only)')
			.setDesc('If git is not findable via your system PATH, then provide its location here')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('my-plugin-setting-text2'));

		new Setting(containerEl)
			.setName('[OPTIONAL] Auto sync on startup')
			.setDesc('Automatically sync when you start Obsidian if there are unsynced changes')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('[OPTIONAL] Auto sync at interval (minutes)')
			.setDesc('Set a positive integer minute interval after which your vault is synced automatically. Leave empty to disable.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('[MOBILE] GitHub Username')
			.setDesc('For mobile sync via HTTPS')
			.addText(text => text
				.setValue(this.plugin.settings.githubUsername)
				.onChange(async (value) => {
					this.plugin.settings.githubUsername = value;
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('[MOBILE] GitHub Token')
			.setDesc('For mobile sync via HTTPS (generate a personal access token with repo permissions)')
			.addText(text => text
				.setValue(this.plugin.settings.githubToken)
				.onChange(async (value) => {
					this.plugin.settings.githubToken = value;
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('my-plugin-setting-text'));
	}
}
