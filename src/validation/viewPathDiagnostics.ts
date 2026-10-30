import * as vscode from 'vscode';
import * as path from 'path';
import { IViewLocator } from '../domain/interfaces/IViewLocator';
import { IActionParser } from '../domain/interfaces/IActionParser';
import { IFileRepository } from '../domain/interfaces/IFileRepository';
import { Action } from '../domain/entities/Action';
import { View } from '../domain/entities/View';
import { IPathResolver, ViewPathOptions } from '../domain/interfaces/IPathResolver';
import { IConfigurationService } from '../domain/interfaces/IConfigurationService';
import { IYiiProjectDetector } from '../domain/interfaces/IYiiProjectDetector';
import { RENDER_PATTERN_REGEX } from '../infrastructure/constant/RegexConst';
import { ViewResolver } from '../infrastructure/view-resolution/ViewResolver';
import { getModuleFromPath, resolvePathCaseInsensitive } from '../infrastructure/utils/moduleUtils';

/**
 * Diagnostics provider for view paths in render/renderPartial calls
 * Checks if view files exist and shows warnings/errors
 * Also provides code actions to create missing view files
 */
export class ViewPathDiagnostics implements vscode.CodeActionProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private viewLocator: IViewLocator;
    private actionParser: IActionParser;
    private fileRepository: IFileRepository;
    private pathResolver: IPathResolver;
    private configService: IConfigurationService;
    private projectDetector: IYiiProjectDetector;
    private viewResolver: ViewResolver;

    constructor(
        viewLocator: IViewLocator,
        actionParser: IActionParser,
        fileRepository: IFileRepository,
        pathResolver: IPathResolver,
        configService: IConfigurationService,
        projectDetector: IYiiProjectDetector
    ) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('yii1-view-paths');
        this.viewLocator = viewLocator;
        this.actionParser = actionParser;
        this.fileRepository = fileRepository;
        this.pathResolver = pathResolver;
        this.configService = configService;
        this.projectDetector = projectDetector;
        this.viewResolver = new ViewResolver(fileRepository, configService);
    }

    public getDiagnosticCollection(): vscode.DiagnosticCollection {
        return this.diagnosticCollection;
    }

    /**
     * Update diagnostics for a document
     */
    public async updateDiagnostics(document: vscode.TextDocument): Promise<void> {
        const diagnostics: vscode.Diagnostic[] = [];

        // Only work on PHP files
        if (document.languageId !== 'php') {
            this.diagnosticCollection.set(document.uri, diagnostics);
            return;
        }

        const filePath = document.uri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        
        if (!workspaceFolder) {
            this.diagnosticCollection.set(document.uri, diagnostics);
            return;
        }

        // Check if it's a Yii project
        if (!this.projectDetector.isYiiProjectSync(workspaceFolder.uri.fsPath)) {
            this.diagnosticCollection.set(document.uri, diagnostics);
            return;
        }
        
        // Check if it's a controller file
        const isController = this.projectDetector.isControllerFile(filePath, workspaceFolder.uri.fsPath);
        
        // Check if it's a view file
        const isView = this.projectDetector.isViewFile(filePath, workspaceFolder.uri.fsPath);

        // Only check controller and view files
        if (!isController && !isView) {
            this.diagnosticCollection.set(document.uri, diagnostics);
            return;
        }

        if (isController) {
            // For controllers, check render/renderPartial calls in action methods
            const actionInfos = await this.actionParser.findAllActions(document);

            // Check each action for render/renderPartial calls
            for (const actionInfo of actionInfos) {
                // Create Action entity
                const action = new Action(
                    actionInfo.name,
                    actionInfo.position,
                    actionInfo.startOffset,
                    actionInfo.endOffset,
                    document
                );
                
                const actionDiagnostics = await this.checkActionViews(document, action);
                diagnostics.push(...actionDiagnostics);
            }
        } else if (isView) {
            // For view files, check render/renderPartial calls throughout the entire file
            const viewDiagnostics = await this.checkViewFile(document);
            diagnostics.push(...viewDiagnostics);
        }

        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    /**
     * Check views in an action and return diagnostics
     */
    private async checkActionViews(
        document: vscode.TextDocument,
        action: Action
    ): Promise<vscode.Diagnostic[]> {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        
        // Find all render/renderPartial calls in the action
        const renderPattern = RENDER_PATTERN_REGEX;
        const actionStart = document.offsetAt(action.position);
        const actionEnd = this.findActionEnd(text, actionStart);
        const actionText = text.substring(actionStart, actionEnd);

        let match;
        while ((match = renderPattern.exec(actionText)) !== null) {
            const isPartial = match[1] === 'renderPartial';
            const viewName = match[2];
            const matchOffset = actionStart + match.index;
            const matchPosition = document.positionAt(matchOffset);
            
            // Find the exact range of the view name string
            const viewNameStart = matchOffset + match[0].indexOf(viewName);
            const viewNameEnd = viewNameStart + viewName.length;
            const viewNameRange = new vscode.Range(
                document.positionAt(viewNameStart),
                document.positionAt(viewNameEnd)
            );

            // Resolve view path using ViewResolver (matching Yii's resolveViewFile logic)
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) {
                continue;
            }
            
            const workspaceRoot = workspaceFolder.uri.fsPath;
            const documentPath = document.uri.fsPath;
            
            // Get controller info to determine view path
            const controllerInfo = this.pathResolver.getControllerInfo(documentPath, workspaceRoot);
            const moduleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
            
            // Determine viewPath (controller's view directory)
            let viewPath: string;
            if (controllerInfo) {
                if (controllerInfo.isInControllers) {
                    // Controller file - get corresponding views directory
                    const viewsDir = moduleName 
                        ? this.configService.getViewsDirectory(workspaceRoot, moduleName)
                        : this.configService.getViewsDirectory(workspaceRoot);
                    viewPath = this.resolveControllerViewDir(viewsDir, controllerInfo.name);
                } else {
                    // Already in views directory
                    viewPath = path.dirname(documentPath);
                }
            } else {
                // Fallback to document directory
                viewPath = path.dirname(documentPath);
            }
            
            // Get basePath (main app views directory)
            const basePath = this.viewResolver.getBasePath(workspaceRoot);
            
            // Get moduleViewPath (null if not in module, otherwise module views directory)
            const moduleViewPath = moduleName 
                ? this.viewResolver.getModuleViewPath(moduleName, workspaceRoot)
                : null;
            
            // Resolve view file using ViewResolver
            const resolvedPath = this.viewResolver.resolveViewFile(
                viewName,
                viewPath,
                basePath,
                moduleViewPath,
                workspaceRoot,
                isPartial
            );

            if (!resolvedPath) {
                // View path could not be resolved - create diagnostic
                const diagnostic = new vscode.Diagnostic(
                    viewNameRange,
                    `Cannot resolve view path: "${viewName}"${isPartial ? ' (partial)' : ''}. Check path format.`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.code = 'view-path-unresolved';
                diagnostic.source = 'yii1-view-paths';
                diagnostics.push(diagnostic);
            } else {
                // Check if the resolved path exists
                const pathExists = this.fileRepository.existsSync(resolvedPath);
                
                if (!pathExists) {
                    // For partials, ViewResolver checks both _view.php and view.php
                    // If resolvedPath doesn't exist, check if the alternative exists
                    let alternativePath: string | null = null;
                    let alternativeExists = false;
                    
                    if (isPartial) {
                        // Try the alternative partial path
                        const dir = path.dirname(resolvedPath);
                        const baseName = path.basename(resolvedPath, '.php');
                        
                        if (baseName.startsWith('_')) {
                            // Current path has underscore, try without
                            alternativePath = path.join(dir, `${baseName.substring(1)}.php`);
                        } else {
                            // Current path doesn't have underscore, try with
                            alternativePath = path.join(dir, `_${baseName}.php`);
                        }
                        
                        if (alternativePath) {
                            alternativeExists = this.fileRepository.existsSync(alternativePath);
                        }
                    }
                    
                    if (alternativeExists && alternativePath) {
                        // Alternative exists - show hint diagnostic (not an error)
                        const relativePath = path.relative(workspaceRoot, alternativePath);
                        
                        const diagnostic = new vscode.Diagnostic(
                            viewNameRange,
                            `View exists at: ${relativePath}${isPartial ? ' (partial)' : ''}`,
                            vscode.DiagnosticSeverity.Information
                        );
                        diagnostic.code = 'view-alternative-path';
                        diagnostic.source = 'yii1-view-paths';
                        diagnostics.push(diagnostic);
                    } else {
                        // File doesn't exist at either path - create error diagnostic
                        const checkedPaths: string[] = [];
                        checkedPaths.push(path.relative(workspaceRoot, resolvedPath));
                        if (alternativePath) {
                            checkedPaths.push(path.relative(workspaceRoot, alternativePath));
                        }
                        
                        const message = checkedPaths.length > 1
                            ? `View file does not exist. Checked paths: ${checkedPaths.join(', ')}`
                            : `View file does not exist: ${checkedPaths[0]}`;
                        
                        const diagnostic = new vscode.Diagnostic(
                            viewNameRange,
                            message,
                            vscode.DiagnosticSeverity.Error
                        );
                        diagnostic.code = 'view-file-missing';
                        diagnostic.source = 'yii1-view-paths';
                        diagnostics.push(diagnostic);
                    }
                }
            }
        }

        return diagnostics;
    }

    /**
     * Resolve a controller's view directory, falling back to a case-insensitive
     * lookup when the directory exists on disk with a different casing
     * (e.g. views/Member vs views/member).
     */
    private resolveControllerViewDir(viewsDir: string, controllerName: string): string {
        return resolvePathCaseInsensitive(
            path.join(viewsDir, controllerName),
            (p) => this.fileRepository.existsSync(p)
        );
    }

    /**
     * Find the end of an action method
     */
    private findActionEnd(text: string, startOffset: number): number {
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
        let i = startOffset;

        // Find the opening brace of the method
        while (i < text.length) {
            if (text[i] === '{') {
                braceCount = 1;
                i++;
                break;
            }
            i++;
        }

        // Find the matching closing brace
        while (i < text.length) {
            const char = text[i];
            const prevChar = i > 0 ? text[i - 1] : '';

            // Handle string literals
            if ((char === '"' || char === "'") && prevChar !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                    stringChar = '';
                }
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        return i + 1;
                    }
                }
            }

            i++;
        }

        return text.length;
    }

    /**
     * Check render/renderPartial calls in view files
     */
    private async checkViewFile(
        document: vscode.TextDocument
    ): Promise<vscode.Diagnostic[]> {
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        
        // Find all render/renderPartial calls in the entire file
        const renderPattern = RENDER_PATTERN_REGEX;

        let match;
        while ((match = renderPattern.exec(text)) !== null) {
            const isPartial = match[1] === 'renderPartial';
            const viewName = match[2];
            const matchOffset = match.index;
            const matchPosition = document.positionAt(matchOffset);
            
            // Find the exact range of the view name string
            const viewNameStart = matchOffset + match[0].indexOf(viewName);
            const viewNameEnd = viewNameStart + viewName.length;
            const viewNameRange = new vscode.Range(
                document.positionAt(viewNameStart),
                document.positionAt(viewNameEnd)
            );

            // Resolve view path using ViewResolver (matching Yii's resolveViewFile logic)
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!workspaceFolder) {
                continue;
            }
            
            const workspaceRoot = workspaceFolder.uri.fsPath;
            const documentPath = document.uri.fsPath;
            
            // Get controller info to determine view path
            const controllerInfo = this.pathResolver.getControllerInfo(documentPath, workspaceRoot);
            const moduleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
            
            // Determine viewPath (controller's view directory)
            let viewPath: string;
            if (controllerInfo) {
                if (controllerInfo.isInControllers) {
                    // Controller file - get corresponding views directory
                    const viewsDir = moduleName 
                        ? this.configService.getViewsDirectory(workspaceRoot, moduleName)
                        : this.configService.getViewsDirectory(workspaceRoot);
                    viewPath = this.resolveControllerViewDir(viewsDir, controllerInfo.name);
                } else {
                    // Already in views directory
                    viewPath = path.dirname(documentPath);
                }
            } else {
                // Fallback to document directory
                viewPath = path.dirname(documentPath);
            }
            
            // Get basePath (main app views directory)
            const basePath = this.viewResolver.getBasePath(workspaceRoot);
            
            // Get moduleViewPath (null if not in module, otherwise module views directory)
            const moduleViewPath = moduleName 
                ? this.viewResolver.getModuleViewPath(moduleName, workspaceRoot)
                : null;
            
            // Resolve view file using ViewResolver
            const resolvedPath = this.viewResolver.resolveViewFile(
                viewName,
                viewPath,
                basePath,
                moduleViewPath,
                workspaceRoot,
                isPartial
            );

            if (!resolvedPath) {
                // View path could not be resolved - create diagnostic
                const diagnostic = new vscode.Diagnostic(
                    viewNameRange,
                    `Cannot resolve view path: "${viewName}"${isPartial ? ' (partial)' : ''}. Check path format.`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.code = 'view-path-unresolved';
                diagnostic.source = 'yii1-view-paths';
                diagnostics.push(diagnostic);
            } else {
                // Check if the resolved path exists
                const pathExists = this.fileRepository.existsSync(resolvedPath);
                
                if (!pathExists) {
                    // For partials, ViewResolver checks both _view.php and view.php
                    // If resolvedPath doesn't exist, check if the alternative exists
                    let alternativePath: string | null = null;
                    let alternativeExists = false;
                    
                    if (isPartial) {
                        // Try the alternative partial path
                        const dir = path.dirname(resolvedPath);
                        const baseName = path.basename(resolvedPath, '.php');
                        
                        if (baseName.startsWith('_')) {
                            // Current path has underscore, try without
                            alternativePath = path.join(dir, `${baseName.substring(1)}.php`);
                        } else {
                            // Current path doesn't have underscore, try with
                            alternativePath = path.join(dir, `_${baseName}.php`);
                        }
                        
                        if (alternativePath) {
                            alternativeExists = this.fileRepository.existsSync(alternativePath);
                        }
                    }
                    
                    if (alternativeExists && alternativePath) {
                        // Alternative exists - show hint diagnostic (not an error)
                        const relativePath = path.relative(workspaceRoot, alternativePath);
                        
                        const diagnostic = new vscode.Diagnostic(
                            viewNameRange,
                            `View exists at: ${relativePath}${isPartial ? ' (partial)' : ''}`,
                            vscode.DiagnosticSeverity.Information
                        );
                        diagnostic.code = 'view-alternative-path';
                        diagnostic.source = 'yii1-view-paths';
                        diagnostics.push(diagnostic);
                    } else {
                        // File doesn't exist at either path - create error diagnostic
                        const checkedPaths: string[] = [];
                        checkedPaths.push(path.relative(workspaceRoot, resolvedPath));
                        if (alternativePath) {
                            checkedPaths.push(path.relative(workspaceRoot, alternativePath));
                        }
                        
                        const message = checkedPaths.length > 1
                            ? `View file does not exist. Checked paths: ${checkedPaths.join(', ')}`
                            : `View file does not exist: ${checkedPaths[0]}`;
                        
                        const diagnostic = new vscode.Diagnostic(
                            viewNameRange,
                            message,
                            vscode.DiagnosticSeverity.Error
                        );
                        diagnostic.code = 'view-file-missing';
                        diagnostic.source = 'yii1-view-paths';
                        diagnostics.push(diagnostic);
                    }
                }
            }
        }

        return diagnostics;
    }



    /**
     * Provide code actions for view file diagnostics
     */
    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        const codeActions: vscode.CodeAction[] = [];
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        
        if (!workspaceFolder) {
            return codeActions;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Check if there's a diagnostic for missing view file
        for (const diagnostic of context.diagnostics) {
            if (diagnostic.code === 'view-file-missing' && diagnostic.range && diagnostic.source === 'yii1-view-paths') {
                // Extract view name from the diagnostic range
                const viewNameText = document.getText(diagnostic.range);
                
                // Find the render call to get more context
                const line = document.lineAt(diagnostic.range.start.line);
                const renderMatch = line.text.match(/(?:->|::)\s*(render(?:Partial)?)\s*\(\s*['"]([^'"]+)['"]/);
                
                if (renderMatch) {
                    const isPartial = false
                    const viewName = renderMatch[2];
                    
                    // Resolve the view path using ViewResolver
                    const documentPath = document.uri.fsPath;
                    const controllerInfo = this.pathResolver.getControllerInfo(documentPath, workspaceRoot);
                    const moduleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
                    
                    // Determine viewPath (controller's view directory)
                    let viewPath: string;
                    if (controllerInfo) {
                        if (controllerInfo.isInControllers) {
                            const viewsDir = moduleName 
                                ? this.configService.getViewsDirectory(workspaceRoot, moduleName)
                                : this.configService.getViewsDirectory(workspaceRoot);
                            viewPath = this.resolveControllerViewDir(viewsDir, controllerInfo.name);
                        } else {
                            viewPath = path.dirname(documentPath);
                        }
                    } else {
                        viewPath = path.dirname(documentPath);
                    }
                    
                    const basePath = this.viewResolver.getBasePath(workspaceRoot);
                    const moduleViewPath = moduleName 
                        ? this.viewResolver.getModuleViewPath(moduleName, workspaceRoot)
                        : null;
                    
                    // Resolve the expected file path
                    const resolvedPath = this.viewResolver.resolveViewFile(
                        viewName,
                        viewPath,
                        basePath,
                        moduleViewPath,
                        workspaceRoot,
                        isPartial
                    );
                    
                    if (resolvedPath && !this.fileRepository.existsSync(resolvedPath)) {
                        const action = new vscode.CodeAction(
                            `Create view file: ${path.basename(resolvedPath)}`,
                            vscode.CodeActionKind.QuickFix
                        );
                        action.command = {
                            command: 'yii1.createViewFile',
                            title: 'Create View File',
                            arguments: [resolvedPath, viewName, isPartial]
                        };
                        action.diagnostics = [diagnostic];
                        action.isPreferred = true;
                        codeActions.push(action);
                    }
                }
            }
        }

        return codeActions.length > 0 ? codeActions : undefined;
    }
}

