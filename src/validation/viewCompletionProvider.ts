import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IFileRepository } from '../domain/interfaces/IFileRepository';
import { IPathResolver } from '../domain/interfaces/IPathResolver';
import { IConfigurationService } from '../domain/interfaces/IConfigurationService';
import { ICache } from '../domain/interfaces/ICache';
import { ViewResolver } from '../infrastructure/view-resolution/ViewResolver';
import { getModuleFromPath, lcFirst, resolvePathCaseInsensitive } from '../infrastructure/utils/moduleUtils';

/**
 * Completion provider for view names in render/renderPartial calls
 */
export class ViewCompletionProvider implements vscode.CompletionItemProvider {
    private fileWatcher: vscode.FileSystemWatcher | null = null;
    private viewResolver: ViewResolver;

    constructor(
        private readonly fileRepository: IFileRepository,
        private readonly pathResolver: IPathResolver,
        private readonly configService: IConfigurationService,
        private readonly viewCache: ICache<string[]>
    ) {
        this.viewResolver = new ViewResolver(fileRepository, configService);
        this.setupFileWatcher();
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const line = document.lineAt(position);
        const lineText = line.text;
        const textBeforeCursor = lineText.substring(0, position.character);
        const textAfterCursor = lineText.substring(position.character);

        // Check if we're inside a render/renderPartial call
        const renderInfo = this.findRenderCallAtPosition(document, position, textBeforeCursor, textAfterCursor);
        if (!renderInfo) {
            return null;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return null;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;
        const currentPath = renderInfo.currentPath || '';

        // Set up text replacement range
        const replaceStart = new vscode.Position(position.line, renderInfo.quoteStart);
        const replaceEnd = new vscode.Position(position.line, renderInfo.quoteEnd);

        // Get segment-based completions based on path type
        const completions = this.getSegmentBasedCompletions(
            document,
            workspaceRoot,
            currentPath,
            renderInfo,
            replaceStart,
            replaceEnd
        );

        // Return CompletionList with isIncomplete: false to prevent merging with other providers
        // This ensures only our completions are shown, excluding VSCode defaults and other extensions
        return new vscode.CompletionList(completions, false);
    }

    /**
     * Find render/renderPartial call at cursor position
     */
    private findRenderCallAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position,
        textBeforeCursor: string,
        textAfterCursor: string
    ): {
        currentPath: string;
        isPartial: boolean;
        isRelative: boolean;
        isAbsolute: boolean;
        isDotNotation: boolean;
        isDoubleSlash: boolean;
        quoteStart: number;
        quoteEnd: number;
    } | null {
        // Pattern to match render('view') or renderPartial('view')
        const renderPattern = /(?:->|::)\s*(render(?:Partial)?)\s*\(\s*['"]([^'"]*)$/;
        const match = textBeforeCursor.match(renderPattern);
        
        if (!match) {
            return null;
        }

        const isPartial = match[1] === 'renderPartial';
        const currentPath = match[2] || '';
        const quoteChar = match[0].includes("'") ? "'" : '"';
        const quoteStartIndex = match.index! + match[0].indexOf(quoteChar) + 1;

        // Check if there's a closing quote after cursor
        const closingQuoteMatch = textAfterCursor.match(/^[^'"]*['"]/);
        const quoteEndIndex = closingQuoteMatch 
            ? position.character + closingQuoteMatch[0].length - 1
            : position.character;

        // Check for double slash // (absolute from beginning/main app)
        const isDoubleSlash = currentPath.startsWith('//');
        // Check for single slash / (controller/view)
        const isAbsolute = currentPath.startsWith('/') && !isDoubleSlash;
        const isRelative = currentPath.startsWith('../') || currentPath.startsWith('./');
        const isDotNotation = currentPath.includes('.') && !isRelative && !isAbsolute && !isDoubleSlash;

        return {
            currentPath,
            isPartial,
            isRelative,
            isAbsolute,
            isDotNotation,
            isDoubleSlash,
            quoteStart: quoteStartIndex,
            quoteEnd: quoteEndIndex
        };
    }

    /**
     * Get segment-based completions for render/renderPartial paths
     * Similar to import completion, shows segments progressively
     */
    private getSegmentBasedCompletions(
        document: vscode.TextDocument,
        workspaceRoot: string,
        currentPath: string,
        renderInfo: {
            isPartial: boolean;
            isRelative: boolean;
            isAbsolute: boolean;
            isDotNotation: boolean;
            isDoubleSlash: boolean;
        },
        replaceStart: vscode.Position,
        replaceEnd: vscode.Position
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];

        if (renderInfo.isDoubleSlash) {
            // Double slash // - absolute from beginning (main app, not module)
            return this.getDoubleSlashCompletions(workspaceRoot, currentPath, renderInfo.isPartial, replaceStart, replaceEnd);
        } else if (renderInfo.isAbsolute) {
            // Single slash / - controller/view
            return this.getSingleSlashCompletions(workspaceRoot, currentPath, renderInfo.isPartial, document, replaceStart, replaceEnd);
        } else if (renderInfo.isDotNotation) {
            // Dot notation - application.views.layouts.main
            return this.getDotNotationSegmentCompletions(workspaceRoot, currentPath, renderInfo.isPartial, replaceStart, replaceEnd);
        } else if (renderInfo.isRelative) {
            // Relative with slash - layouts/main or ../layouts/main
            return this.getRelativeSlashCompletions(document, workspaceRoot, currentPath, renderInfo.isPartial, replaceStart, replaceEnd);
        } else {
            // Just a name - relative to current controller
            return this.getRelativeNameCompletions(document, workspaceRoot, currentPath, renderInfo.isPartial, replaceStart, replaceEnd);
        }
    }

    /**
     * Get segment-based completions for double slash // paths (absolute from beginning/main app)
     */
    private getDoubleSlashCompletions(
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean,
        replaceStart: vscode.Position,
        replaceEnd: vscode.Position
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        // Remove // prefix
        const pathAfterDoubleSlash = currentPath.substring(2);
        const pathParts = pathAfterDoubleSlash.split('/').filter(p => p.length > 0);
        
        const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
        
        // Build path progressively
        let currentDir = viewsDir;
        for (let i = 0; i < pathParts.length - 1; i++) {
            currentDir = path.join(currentDir, pathParts[i]);
            if (!this.fileRepository.existsSync(currentDir)) {
                return completions; // Path doesn't exist
            }
        }
        
        // Get next segments
        if (pathParts.length === 0) {
            // Show controllers
            const controllers = this.getDirectories(viewsDir);
            for (const controller of controllers) {
                const item = new vscode.CompletionItem(controller, vscode.CompletionItemKind.Folder);
                item.textEdit = new vscode.TextEdit(
                    new vscode.Range(replaceStart, replaceEnd),
                    `//${controller}`
                );
                item.filterText = `//${controller}`;
                item.detail = 'Controller (Main App)';
                completions.push(item);
            }
        } else if (pathParts.length === 1) {
            // Show views in controller
            const controllerDir = resolvePathCaseInsensitive(
                path.join(viewsDir, pathParts[0]),
                (p) => this.fileRepository.existsSync(p)
            );
            if (this.fileRepository.existsSync(controllerDir)) {
                const views = this.getViewsInDirectory(controllerDir, isPartial);
                for (const view of views) {
                    const item = new vscode.CompletionItem(view, vscode.CompletionItemKind.Enum);
                    item.textEdit = new vscode.TextEdit(
                        new vscode.Range(replaceStart, replaceEnd),
                        `//${pathParts[0]}/${view}`
                    );
                    item.filterText = `//${pathParts[0]}/${view}`;
                    item.detail = 'View (Main App)';
                    completions.push(item);
                }
            }
        }
        
        return completions;
    }

    /**
     * Get segment-based completions for single slash / paths (controller/view)
     */
    private getSingleSlashCompletions(
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean,
        document: vscode.TextDocument,
        replaceStart: vscode.Position,
        replaceEnd: vscode.Position
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const pathParts = currentPath.substring(1).split('/').filter(p => p.length > 0);
        
        // Check module first if document is in a module
        const moduleName = getModuleFromPath(document.uri.fsPath, workspaceRoot, this.configService.getModulesPath());
        const viewsDir = moduleName 
            ? this.configService.getViewsDirectory(workspaceRoot, moduleName)
            : this.configService.getViewsDirectory(workspaceRoot);
        
        if (pathParts.length === 0) {
            // Show controllers
            const controllers = this.getDirectories(viewsDir);
            for (const controller of controllers) {
                const item = new vscode.CompletionItem(controller, vscode.CompletionItemKind.Folder);
                item.textEdit = new vscode.TextEdit(
                    new vscode.Range(replaceStart, replaceEnd),
                    `/${controller}`
                );
                item.filterText = `/${controller}`;
                item.detail = moduleName ? `Controller (${moduleName})` : 'Controller';
                completions.push(item);
            }
        } else if (pathParts.length === 1) {
            // Show views in controller
            const controllerDir = resolvePathCaseInsensitive(
                path.join(viewsDir, pathParts[0]),
                (p) => this.fileRepository.existsSync(p)
            );
            if (this.fileRepository.existsSync(controllerDir)) {
                const views = this.getViewsInDirectory(controllerDir, isPartial);
                for (const view of views) {
                    const item = new vscode.CompletionItem(view, vscode.CompletionItemKind.Enum);
                    item.textEdit = new vscode.TextEdit(
                        new vscode.Range(replaceStart, replaceEnd),
                        `/${pathParts[0]}/${view}`
                    );
                    item.filterText = `/${pathParts[0]}/${view}`;
                    item.detail = 'View';
                    completions.push(item);
                }
            }
        }
        
        return completions;
    }

    /**
     * Get segment-based completions for dot notation paths
     */
    private getDotNotationSegmentCompletions(
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean,
        replaceStart: vscode.Position,
        replaceEnd: vscode.Position
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        
        // Normalize the prefix - handle trailing dots
        let prefix = currentPath || '';
        const hasTrailingDot = prefix.endsWith('.');
        prefix = prefix.replace(/\.+$/, '');
        const prefixParts = prefix.split('.').filter(p => p.length > 0);
        
        // Find all unique next segments at the current depth
        const nextSegments = new Set<string>();
        const viewsIndex = this.buildViewsIndex(workspaceRoot);
        
        for (const fullPath of viewsIndex) {
            const pathParts = fullPath.split('.');
            
            if (prefixParts.length === 0) {
                // Show top-level segments
                if (pathParts.length > 0) {
                    nextSegments.add(pathParts[0]);
                }
            } else {
                // Check if path starts with current prefix
                let matches = true;
                for (let i = 0; i < prefixParts.length; i++) {
                    if (i >= pathParts.length || pathParts[i] !== prefixParts[i]) {
                        matches = false;
                        break;
                    }
                }
                
                if (matches && pathParts.length > prefixParts.length) {
                    nextSegments.add(pathParts[prefixParts.length]);
                }
            }
        }
        
        // Create completion items
        for (const segment of Array.from(nextSegments).sort()) {
            const segmentsSoFar = prefixParts.length > 0 
                ? [...prefixParts, segment].join('.')
                : segment;
            
            const hasChildren = viewsIndex.some(p => {
                const parts = p.split('.');
                const currentParts = segmentsSoFar.split('.');
                return parts.length > currentParts.length && 
                       parts.slice(0, currentParts.length).join('.') === segmentsSoFar;
            });
            
            const item = new vscode.CompletionItem(
                segment,
                hasChildren ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Enum
            );
            
            item.textEdit = new vscode.TextEdit(
                new vscode.Range(replaceStart, replaceEnd),
                segmentsSoFar
            );
            item.filterText = segmentsSoFar;
            item.detail = 'View path';
            item.documentation = `View: ${segmentsSoFar}`;
            item.sortText = `0_${segment}`;
            completions.push(item);
        }
        
        return completions;
    }

    /**
     * Get segment-based completions for relative paths with slash
     */
    private getRelativeSlashCompletions(
        document: vscode.TextDocument,
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean,
        replaceStart: vscode.Position,
        replaceEnd: vscode.Position
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const documentDir = path.dirname(document.uri.fsPath);
        
        // Remove ../ or ./
        const pathAfterPrefix = currentPath.replace(/^\.\.?\//, '');
        const pathParts = pathAfterPrefix.split('/').filter(p => p.length > 0);
        
        // Resolve base directory
        const baseDir = currentPath.startsWith('../') 
            ? path.resolve(documentDir, '..')
            : documentDir;
        
        let currentDir = baseDir;
        for (let i = 0; i < pathParts.length - 1; i++) {
            currentDir = path.join(currentDir, pathParts[i]);
            if (!this.fileRepository.existsSync(currentDir)) {
                return completions;
            }
        }
        
        if (pathParts.length === 0) {
            // Show directories and views in current directory
            const entries = this.getDirectoryEntries(currentDir);
            for (const entry of entries) {
                const entryPath = path.join(currentDir, entry);
                const isDir = this.fileRepository.existsSync(entryPath) && 
                             fs.statSync(entryPath).isDirectory();
                
                const item = new vscode.CompletionItem(
                    entry,
                    isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Enum
                );
                const prefix = currentPath.startsWith('../') ? '../' : './';
                item.textEdit = new vscode.TextEdit(
                    new vscode.Range(replaceStart, replaceEnd),
                    `${prefix}${entry}`
                );
                item.filterText = `${prefix}${entry}`;
                item.detail = isDir ? 'Directory' : 'View';
                completions.push(item);
            }
        } else {
            // Show views in the last directory
            const targetDir = pathParts.length > 1 
                ? path.join(baseDir, ...pathParts.slice(0, -1))
                : baseDir;
            
            if (this.fileRepository.existsSync(targetDir)) {
                const views = this.getViewsInDirectory(targetDir, isPartial);
                for (const view of views) {
                    const item = new vscode.CompletionItem(view, vscode.CompletionItemKind.Enum);
                    const prefix = currentPath.startsWith('../') ? '../' : './';
                    const fullPath = `${prefix}${pathParts.slice(0, -1).join('/')}/${view}`.replace(/\/+/g, '/');
                    item.textEdit = new vscode.TextEdit(
                        new vscode.Range(replaceStart, replaceEnd),
                        fullPath
                    );
                    item.filterText = fullPath;
                    item.detail = 'View';
                    completions.push(item);
                }
            }
        }
        
        return completions;
    }

    /**
     * Get segment-based completions for relative paths (just a name)
     */
    private getRelativeNameCompletions(
        document: vscode.TextDocument,
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean,
        replaceStart: vscode.Position,
        replaceEnd: vscode.Position
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        
        // Get controller info to find views directory
        const controllerInfo = this.getControllerInfo(document.uri.fsPath, workspaceRoot);
        if (!controllerInfo) {
            return completions;
        }
        
            let viewsDir = this.configService.getViewsDirectory(workspaceRoot, controllerInfo.moduleName,);
            viewsDir = resolvePathCaseInsensitive(
                path.join(viewsDir, controllerInfo.name),
                (p) => this.fileRepository.existsSync(p)
            );
            if (!this.fileRepository.existsSync(viewsDir)) {
            return completions;
        }
        
        // Filter views by current path prefix
        const views = this.getViewsInDirectory(viewsDir, isPartial);
        for (const view of views) {
            if (!currentPath || view.startsWith(currentPath)) {
                const item = new vscode.CompletionItem(view, vscode.CompletionItemKind.Enum);
                item.textEdit = new vscode.TextEdit(
                    new vscode.Range(replaceStart, replaceEnd),
                    view
                );
                item.filterText = view;
                item.detail = 'View';
                item.documentation = `View: ${view}`;
                item.sortText = `0_${view}`;
                item.preselect = true;
                completions.push(item);
            }
        }
        
        return completions;
    }

    /**
     * Build an index of all view paths in dot notation format
     */
    private buildViewsIndex(workspaceRoot: string): string[] {
        const results = new Set<string>();
        const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
        
        const walk = (root: string, basePath: string) => {
            if (!this.fileRepository.existsSync(root)) {
                return;
            }
            
            const entries = this.getDirectoryEntries(root);
            for (const entry of entries) {
                const full = path.join(root, entry);
                if (this.fileRepository.existsSync(full)) {
                    const stat = fs.statSync(full);
                    if (stat.isDirectory()) {
                        walk(full, `${basePath}.${entry}`);
                    } else if (entry.endsWith('.php')) {
                        const viewName = entry.replace(/\.php$/, '');
                        results.add(`${basePath}.${viewName}`);
                    }
                }
            }
        };
        
        if (this.fileRepository.existsSync(viewsDir)) {
            walk(viewsDir, 'application.views');
        }
        
        // Also check modules
        const modulesPath = path.join(workspaceRoot, 'protected', 'modules');
        if (this.fileRepository.existsSync(modulesPath)) {
            const modules = this.getDirectories(modulesPath);
            for (const module of modules) {
                const moduleViewsDir = path.join(modulesPath, module, 'views');
                if (this.fileRepository.existsSync(moduleViewsDir)) {
                    walk(moduleViewsDir, `application.modules.${module}.views`);
                }
            }
        }
        
        return Array.from(results).sort();
    }

    /**
     * Get directory entries (files and directories)
     */
    private getDirectoryEntries(dir: string): string[] {
        try {
            return fs.readdirSync(dir);
        } catch {
            return [];
        }
    }

    /**
     * Get completions for absolute paths (/controller/view)
     * Returns dot notation paths like application.modules.Sow.views.sow.sow_info
     */
    private getAbsolutePathCompletions(
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean,
        document?: vscode.TextDocument
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const pathParts = currentPath.substring(1).split('/').filter(p => p);
        
        // If we have a controller name, list views in that controller
        if (pathParts.length >= 1) {
            const controllerName = pathParts[0];
            
            // Check module views first if document is in a module
            if (document) {
                const moduleName = getModuleFromPath(document.uri.fsPath, workspaceRoot, this.configService.getModulesPath());
                if (moduleName) {
                    const moduleViewsDir = this.configService.getViewsDirectory(workspaceRoot, moduleName);
                    const moduleControllerViewsDir = resolvePathCaseInsensitive(
                        path.join(moduleViewsDir, controllerName),
                        (p) => this.fileRepository.existsSync(p)
                    );
                    
                    if (this.fileRepository.existsSync(moduleControllerViewsDir)) {
                        const views = this.getViewsInDirectory(moduleControllerViewsDir, isPartial);
                        for (const view of views) {
                            const dotNotationPath = `application.modules.${moduleName}.views.${controllerName}.${view}`;
                            const item = new vscode.CompletionItem(
                                dotNotationPath,
                                vscode.CompletionItemKind.Enum
                            );
                            item.detail = 'View (Module)';
                            item.documentation = `View: ${dotNotationPath}`;
                            completions.push(item);
                        }
                    }
                }
            }
            
            // Also check main app views
            const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
            const controllerViewsDir = resolvePathCaseInsensitive(
                path.join(viewsDir, controllerName),
                (p) => this.fileRepository.existsSync(p)
            );
            
            if (this.fileRepository.existsSync(controllerViewsDir)) {
                const views = this.getViewsInDirectory(controllerViewsDir, isPartial);
                for (const view of views) {
                    const dotNotationPath = `application.views.${controllerName}.${view}`;
                    // Avoid duplicates
                    if (!completions.some(item => {
                        const label = typeof item.label === 'string' ? item.label : item.label.label;
                        return label === dotNotationPath;
                    })) {
                        const item = new vscode.CompletionItem(
                            dotNotationPath,
                            vscode.CompletionItemKind.Enum
                        );
                        item.detail = 'View';
                        item.documentation = `View: ${dotNotationPath}`;
                        completions.push(item);
                    }
                }
            }
        } else {
            // List all controllers with dot notation prefix
            const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
            if (this.fileRepository.existsSync(viewsDir)) {
                const controllers = this.getDirectories(viewsDir);
                for (const controller of controllers) {
                    const dotNotationPath = `application.views.${controller}`;
                    const item = new vscode.CompletionItem(
                        dotNotationPath,
                        vscode.CompletionItemKind.Folder
                    );
                    item.detail = 'Controller';
                    item.documentation = `Controller: ${controller}`;
                    completions.push(item);
                }
            }
            
            // Also list modules if document is in a module context
            if (document) {
                const moduleName = getModuleFromPath(document.uri.fsPath, workspaceRoot, this.configService.getModulesPath());
                if (moduleName) {
                    const moduleViewsDir = this.configService.getViewsDirectory(workspaceRoot, moduleName);
                    if (this.fileRepository.existsSync(moduleViewsDir)) {
                        const controllers = this.getDirectories(moduleViewsDir);
                        for (const controller of controllers) {
                            const dotNotationPath = `application.modules.${moduleName}.views.${controller}`;
                            const item = new vscode.CompletionItem(
                                dotNotationPath,
                                vscode.CompletionItemKind.Folder
                            );
                            item.detail = 'Controller (Module)';
                            item.documentation = `Controller: ${moduleName}/${controller}`;
                            completions.push(item);
                        }
                    }
                }
            }
        }

        return completions;
    }

    /**
     * Get completions for relative paths (../controller/view or ./view)
     */
    private getRelativePathCompletions(
        document: vscode.TextDocument,
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const documentDir = path.dirname(document.uri.fsPath);
        
        // Resolve relative path
        const relativePath = currentPath.replace(/^\.\.?\//, '');
        const resolvedDir = path.resolve(documentDir, relativePath);
        
        if (this.fileRepository.existsSync(resolvedDir)) {
            const views = this.getViewsInDirectory(resolvedDir, isPartial);
            const documentPath = document.uri.fsPath;
            
            // Convert resolved path to dot notation
            const relativePathFromRoot = path.relative(workspaceRoot, resolvedDir);
            const pathParts = relativePathFromRoot.split(path.sep);
            
            const protectedPath = this.configService.getProtectedPath();
            const modulesPath = this.configService.getModulesPath();
            const viewsPath = this.configService.getViewsPath();
            
            const protectedIndex = pathParts.indexOf(protectedPath);
            const modulesIndex = pathParts.indexOf(modulesPath);
            const viewsIndex = pathParts.indexOf(viewsPath);
            
            let dotNotationPrefix: string;
            
            if (protectedIndex !== -1 && modulesIndex !== -1 && viewsIndex !== -1 && viewsIndex > modulesIndex) {
                // Module view: application.modules.ModuleName.views.controller
                const moduleName = pathParts[modulesIndex + 1];
                const controllerName = pathParts[viewsIndex + 1];
                dotNotationPrefix = `application.modules.${moduleName}.views.${controllerName}`;
            } else if (protectedIndex !== -1 && viewsIndex !== -1) {
                // Main app view: application.views.controller
                const controllerName = pathParts[viewsIndex + 1];
                dotNotationPrefix = `application.views.${controllerName}`;
            } else {
                // Fallback: try to determine from document path
                const docModuleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
                const docControllerInfo = this.getControllerInfo(documentPath, workspaceRoot);
                
                if (docModuleName && docControllerInfo) {
                    dotNotationPrefix = `application.modules.${docModuleName}.views.${docControllerInfo.name}`;
                } else if (docControllerInfo) {
                    dotNotationPrefix = `application.views.${docControllerInfo.name}`;
                } else {
                    dotNotationPrefix = 'application.views';
                }
            }
            
            for (const view of views) {
                const dotNotationPath = `${dotNotationPrefix}.${view}`;
                const item = new vscode.CompletionItem(
                    dotNotationPath,
                    vscode.CompletionItemKind.Enum
                );
                item.detail = 'View';
                item.documentation = `View: ${dotNotationPath}`;
                completions.push(item);
            }
        }

        return completions;
    }

    /**
     * Get completions for dot notation paths
     */
    private getDotNotationCompletions(
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const parts = currentPath.split('.');
        
        // Handle application.modules.Module.views.controller.view
        if (parts.length >= 5 && parts[0] === 'application' && parts[1] === 'modules' && parts[3] === 'views') {
            const moduleName = parts[2];
            const controllerName = parts[4];
            const viewsDir = this.configService.getViewsDirectory(workspaceRoot, moduleName);
            const controllerViewsDir = resolvePathCaseInsensitive(
                path.join(viewsDir, controllerName),
                (p) => this.fileRepository.existsSync(p)
            );
            
            if (this.fileRepository.existsSync(controllerViewsDir)) {
                const views = this.getViewsInDirectory(controllerViewsDir, isPartial);
                for (const view of views) {
                    const item = new vscode.CompletionItem(
                        `application.modules.${moduleName}.views.${controllerName}.${view}`,
                        vscode.CompletionItemKind.Enum
                    );
                    item.detail = 'View';
                    completions.push(item);
                }
            }
        } else if (parts.length >= 3 && parts[0] === 'application' && parts[1] === 'views') {
            // Handle application.views.controller.view
            const controllerName = parts[2];
            const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
            const controllerViewsDir = resolvePathCaseInsensitive(
                path.join(viewsDir, controllerName),
                (p) => this.fileRepository.existsSync(p)
            );
            
            if (this.fileRepository.existsSync(controllerViewsDir)) {
                const views = this.getViewsInDirectory(controllerViewsDir, isPartial);
                for (const view of views) {
                    const item = new vscode.CompletionItem(
                        `application.views.${controllerName}.${view}`,
                        vscode.CompletionItemKind.Enum
                    );
                    item.detail = 'View';
                    completions.push(item);
                }
            }
        }

        return completions;
    }

    /**
     * Get completions for standard view resolution (based on current controller)
     * Returns dot notation paths like application.modules.Sow.views.sow.sow_info
     */
    private getStandardViewCompletions(
        document: vscode.TextDocument,
        workspaceRoot: string,
        currentPath: string,
        isPartial: boolean
    ): vscode.CompletionItem[] {
        const completions: vscode.CompletionItem[] = [];
        const documentPath = document.uri.fsPath;
        
        // Get controller info
        const controllerInfo = this.getControllerInfo(documentPath, workspaceRoot);
        const moduleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
        
        let viewsDir: string;
        let dotNotationPrefix: string;
        
        if (moduleName && controllerInfo) {
            // Module views: application.modules.ModuleName.views.controller.view
            viewsDir = resolvePathCaseInsensitive(
                path.join(
                    this.configService.getViewsDirectory(workspaceRoot, moduleName),
                    controllerInfo.name
                ),
                (p) => this.fileRepository.existsSync(p)
            );
            dotNotationPrefix = `application.modules.${moduleName}.views.${controllerInfo.name}`;
        } else if (controllerInfo) {
            // Main app views: application.views.controller.view
            viewsDir = resolvePathCaseInsensitive(
                path.join(
                    this.configService.getViewsDirectory(workspaceRoot),
                    controllerInfo.name
                ),
                (p) => this.fileRepository.existsSync(p)
            );
            dotNotationPrefix = `application.views.${controllerInfo.name}`;
        } else {
            // Fallback: current directory if in views folder
            viewsDir = path.dirname(documentPath);
            // Try to determine from path
            const relativePath = path.relative(workspaceRoot, documentPath);
            const pathParts = relativePath.split(path.sep);
            const modulesPath = this.configService.getModulesPath();
            const viewsPath = this.configService.getViewsPath();
            const modulesIndex = pathParts.indexOf(modulesPath);
            const viewsIndex = pathParts.indexOf(viewsPath);
            
            if (modulesIndex !== -1 && viewsIndex !== -1 && viewsIndex > modulesIndex) {
                const moduleNameFromPath = pathParts[modulesIndex + 1];
                const controllerNameFromPath = pathParts[viewsIndex + 1];
                dotNotationPrefix = `application.modules.${moduleNameFromPath}.views.${controllerNameFromPath}`;
            } else if (viewsIndex !== -1 && viewsIndex < pathParts.length - 1) {
                const controllerNameFromPath = pathParts[viewsIndex + 1];
                dotNotationPrefix = `application.views.${controllerNameFromPath}`;
            } else {
                dotNotationPrefix = 'application.views';
            }
        }

        if (this.fileRepository.existsSync(viewsDir)) {
            const views = this.getViewsInDirectory(viewsDir, isPartial);
            for (const view of views) {
                // Use full dot notation path
                const dotNotationPath = `${dotNotationPrefix}.${view}`;
                const item = new vscode.CompletionItem(dotNotationPath, vscode.CompletionItemKind.Enum);
                item.detail = 'View';
                item.documentation = `View: ${dotNotationPath}`;
                completions.push(item);
            }
        }

        return completions;
    }

    /**
     * Get view files in a directory
     */
    private getViewsInDirectory(dirPath: string, isPartial: boolean): string[] {
        const cacheKey = `${dirPath}:${isPartial}`;
        const cached = this.viewCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const views: string[] = [];
        
        if (!this.fileRepository.existsSync(dirPath)) {
            return views;
        }

        try {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
                if (file.endsWith('.php')) {
                    const viewName = file.replace(/\.php$/, '');
                    views.push(viewName);
                    // For partials, include both with and without underscore
                    // if (isPartial) {
                    //     if (viewName.startsWith('_')) {
                    //         views.push(viewName);
                    //         views.push(viewName.substring(1)); // Also suggest without underscore
                    //     } else {
                    //         views.push(viewName);
                    //         views.push(`_${viewName}`); // Also suggest with underscore
                    //     }
                    // } else {
                    //     // For regular views, skip partials (those starting with _)
                    //     if (!viewName.startsWith('_')) {
                    //         views.push(viewName);
                    //     }
                    // }
                }
            }
        } catch (error) {
            // Ignore errors
        }

        // Remove duplicates and sort
        const uniqueViews = Array.from(new Set(views)).sort();
        this.viewCache.set(cacheKey, uniqueViews);
        
        return uniqueViews;
    }

    /**
     * Get subdirectories in a directory
     */
    private getDirectories(dirPath: string): string[] {
        if (!this.fileRepository.existsSync(dirPath)) {
            return [];
        }

        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            return items
                .filter(item => item.isDirectory())
                .map(item => item.name)
                .sort();
        } catch (error) {
            return [];
        }
    }

    /**
     * Get controller info from document path
     */
    private getControllerInfo(
        documentPath: string,
        workspaceRoot: string
    ): { name: string; isInControllers: boolean, moduleName: string|undefined } | null {
        const relativePath = path.relative(workspaceRoot, documentPath);
        const pathParts = relativePath.split(path.sep);
        
        const viewsPath = this.configService.getViewsPath();
        const controllersPath = this.configService.getControllersPath();
        
        const viewsIndex = pathParts.indexOf(viewsPath);
        if (viewsIndex !== -1 && viewsIndex < pathParts.length - 1) {
            return { name: pathParts[viewsIndex + 1], isInControllers: false, moduleName: undefined };
        }
        
        const controllersIndex = pathParts.indexOf(controllersPath);
        if (controllersIndex !== -1 && controllersIndex < pathParts.length - 1) {
            const controllerFile = pathParts[controllersIndex + 1];
            const controllerName = controllerFile.replace(/Controller\.php?$/, '').replace(/Controller$/, '');
            const moduleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
            return {name: lcFirst(controllerName), moduleName: moduleName ? `${moduleName}` : undefined, isInControllers: true };
        }
        
        return null;
    }

    /**
     * Normalize path for filtering - extract key parts from different path formats
     */
    private normalizePathForFiltering(
        currentPath: string,
        renderInfo: { isAbsolute: boolean; isRelative: boolean; isDotNotation: boolean }
    ): string {
        if (!currentPath) {
            return '';
        }

        if (renderInfo.isDotNotation) {
            // Already in dot notation
            return currentPath.toLowerCase();
        } else if (renderInfo.isAbsolute) {
            // Extract controller/view from /controller/view
            const parts = currentPath.substring(1).split('/').filter(p => p);
            return parts.join('.').toLowerCase();
        } else if (renderInfo.isRelative) {
            // Extract from relative path
            const cleanPath = currentPath.replace(/^\.\.?\//, '');
            return cleanPath.replace(/\//g, '.').toLowerCase();
        } else {
            // Standard view name
            return currentPath.toLowerCase();
        }
    }

    /**
     * Check if dot notation path matches the filter
     */
    private matchesFilter(dotNotationPath: string, normalizedPath: string, originalPath: string): boolean {
        if (!normalizedPath || normalizedPath.length === 0) {
            return true;
        }

        const dotPathLower = dotNotationPath.toLowerCase();
        
        // Extract key parts from dot notation path for matching
        // e.g., "application.modules.sow.views.sow.sow_info" -> "sow sow_info"
        const parts = dotPathLower.split('.');
        const keyParts: string[] = [];
        
        // Extract module name, controller name, and view name
        const modulesIndex = parts.indexOf('modules');
        const viewsIndex = parts.indexOf('views');
        
        if (modulesIndex !== -1 && modulesIndex < parts.length - 1) {
            keyParts.push(parts[modulesIndex + 1]); // module name
        }
        if (viewsIndex !== -1 && viewsIndex < parts.length - 1) {
            keyParts.push(parts[viewsIndex + 1]); // controller name
        }
        if (parts.length > 0) {
            keyParts.push(parts[parts.length - 1]); // view name
        }
        
        const keyString = keyParts.join(' ');
        
        // Check if normalized path matches any part
        const normalizedLower = normalizedPath.toLowerCase();
        return keyString.includes(normalizedLower) || 
               dotPathLower.includes(normalizedLower) ||
               keyParts.some(part => part.startsWith(normalizedLower));
    }



    /**
     * Setup file watcher to invalidate cache when view files change
     */
    private setupFileWatcher(): void {
        // Watch for PHP files in views directories
        // Pattern matches: protected/views/**/*.php and protected/modules/*/views/**/*.php
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/views/**/*.php');
        
        this.fileWatcher.onDidCreate((uri) => {
            this.invalidateCacheForDirectory(uri.fsPath);
        });
        
        this.fileWatcher.onDidDelete((uri) => {
            this.invalidateCacheForDirectory(uri.fsPath);
        });
        
        this.fileWatcher.onDidChange((uri) => {
            // File content changed, but directory contents didn't, so no need to invalidate
            // However, if the file was renamed, we might need to invalidate
            // For now, we'll only invalidate on create/delete
        });
    }

    /**
     * Invalidate cache entries for a directory when files change
     */
    private invalidateCacheForDirectory(filePath: string): void {
        const dirPath = path.dirname(filePath);
        
        // Clear cache entries for this directory (both partial and non-partial)
        const cacheKeyPartial = `${dirPath}:true`;
        const cacheKeyNonPartial = `${dirPath}:false`;
        
        if (this.viewCache.has(cacheKeyPartial)) {
            this.viewCache.delete(cacheKeyPartial);
        }
        
        if (this.viewCache.has(cacheKeyNonPartial)) {
            this.viewCache.delete(cacheKeyNonPartial);
        }
    }

    /**
     * Dispose resources
     */
    public dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = null;
        }
        this.viewCache.clear();
    }
}

