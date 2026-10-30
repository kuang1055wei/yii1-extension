import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { YiiViewDefinitionProvider } from './viewDefinitionProvider';
import { COMMENT_REGEX, RENDER_PATTERN_REGEX } from './infrastructure/constant/RegexConst';
import { resolveDotNotationPath, lcFirst, resolvePathCaseInsensitive } from './infrastructure/utils/moduleUtils';

export interface ViewInfo {
    viewName: string;
    viewPath: string;
    isPartial: boolean;
    isRelative: boolean;
    isAbsolute: boolean;
    isDotNotation: boolean;
}

export class ActionViewLocator {
    private viewDefinitionProvider: YiiViewDefinitionProvider;

    constructor() {
        this.viewDefinitionProvider = new YiiViewDefinitionProvider();
    }

    /**
     * Find all render calls in an action method and extract view information
     */
    async findViewsInAction(
        document: vscode.TextDocument,
        actionName: string,
        actionPosition: vscode.Position
    ): Promise<ViewInfo[]> {
        let text = document.getText();
        text = text.replace(
            COMMENT_REGEX,
            (match, stringLiteral) => stringLiteral || ''
        );

        const actionStart = document.offsetAt(actionPosition);
        
        // Find the end of the action method
        const actionEnd = this.findMethodEnd(text, actionStart);
        if (actionEnd === -1) {
            return [];
        }

        // Extract the method body
        const methodBody = text.substring(actionStart, actionEnd);
        
        const views: ViewInfo[] = [];
        let match;

        while ((match = RENDER_PATTERN_REGEX.exec(methodBody)) !== null) {
            const isPartial = match[1] === 'renderPartial';
            const viewName = match[2];
            
            // Determine view path characteristics
            const isRelative = viewName.startsWith('../') || viewName.startsWith('./');
            const isAbsolute = viewName.startsWith('/');
            const isDotNotation = viewName.includes('.') && !isRelative && !isAbsolute;
            
            // Resolve the view path
            const viewPath = this.resolveViewPath(
                document,
                viewName,
                isPartial,
                isRelative,
                isAbsolute,
                isDotNotation
            );

            if (viewPath) {
                // Avoid duplicates
                const exists = views.some(v => v.viewPath === viewPath);
                if (!exists) {
                    views.push({
                        viewName,
                        viewPath,
                        isPartial,
                        isRelative,
                        isAbsolute,
                        isDotNotation
                    });
                }
            }
        }

        return views;
    }

    /**
     * Find the end position of a method starting at the given offset
     */
    private findMethodEnd(text: string, startOffset: number): number {
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
    
        for (let i = startOffset; i < text.length; i++) {
            const char = text[i];
    
            /* ---------- STRING HANDLING ---------- */
            if (char === '"' || char === "'") {
                // Count backslashes before the quote
                let backslashCount = 0;
                let j = i - 1;
                while (j >= 0 && text[j] === '\\') {
                    backslashCount++;
                    j--;
                }
    
                const isEscaped = backslashCount % 2 === 1;
    
                if (!isEscaped) {
                    if (!inString) {
                        inString = true;
                        stringChar = char;
                    } else if (char === stringChar) {
                        inString = false;
                        stringChar = '';
                    }
                }
                continue;
            }
    
            // Ignore everything inside strings
            if (inString) continue;
    
            /* ---------- BRACE MATCHING ---------- */
            if (char === '{') {
                braceCount++;
            } else if (char === '}') {
                if (braceCount > 0) {
                    braceCount--;
                    if (braceCount === 0) {
                        return i + 1;
                    }
                }
            }
        }
    
        return -1;
    }

    /**
     * Resolve view path using the same logic as YiiViewDefinitionProvider
     */
    private resolveViewPath(
        document: vscode.TextDocument,
        viewName: string,
        isPartial: boolean,
        isRelative: boolean,
        isAbsolute: boolean,
        isDotNotation: boolean
    ): string | null {
        const documentPath = document.uri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        
        if (!workspaceFolder) {
            return null;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Handle dot notation paths
        if (isDotNotation) {
            return this.resolveDotNotationPath(workspaceRoot, viewName, isPartial);
        }

        // Handle absolute paths
        if (isAbsolute) {
            const pathParts = viewName.substring(1).split('/');
            if (pathParts.length >= 2) {
                const controllerName = pathParts[0];
                const viewFileName = pathParts[pathParts.length - 1];
                // Resolve the controller's view directory case-insensitively
                const controllerDir = resolvePathCaseInsensitive(
                    path.join(workspaceRoot, 'protected', 'views', controllerName)
                );
                return path.join(controllerDir, `${viewFileName}.php`);
            }
        }

        // Handle relative paths
        if (isRelative) {
            const documentDir = path.dirname(documentPath);
            const relativePath = viewName.replace(/^\.\.?\//, '');
            let resolvedPath = path.resolve(documentDir, relativePath);
            resolvedPath = resolvedPath.replace(/[/\\]controllers([/\\])/g, path.sep + 'views' + path.sep);
            resolvedPath = resolvedPath.replace(/[/\\]controllers$/g, path.sep + 'views');
            
            if (!resolvedPath.endsWith('.php')) {
                resolvedPath = resolvedPath + '.php';
            }
            
            return resolvedPath;
        }

        // Standard view resolution
        const controllerInfo = this.getControllerInfo(documentPath, workspaceRoot);
        
        if (!controllerInfo) {
            const protectedViewsPath = path.join(workspaceRoot, 'protected', 'views');
            if (fs.existsSync(protectedViewsPath)) {
                const commonPaths = [
                    path.join(protectedViewsPath, 'site', `${viewName}.php`),
                    path.join(protectedViewsPath, 'default', `${viewName}.php`)
                ];
                for (const commonPath of commonPaths) {
                    if (fs.existsSync(commonPath)) {
                        return commonPath;
                    }
                }
            }
            return null;
        }

        let viewPath: string;
        
        if (controllerInfo.isInControllers) {
            const documentDir = path.dirname(documentPath);
            const viewsDir = documentDir.replace(/[/\\]controllers([/\\]|$)/g, path.sep + 'views' + path.sep);
            
            // Resolve the controller's view directory case-insensitively
            const controllerDir = resolvePathCaseInsensitive(
                path.join(viewsDir, controllerInfo.name)
            );
            
            if (isPartial) {
                const partialPath1 = path.join(controllerDir, `_${viewName}.php`);
                const partialPath2 = path.join(controllerDir, `${viewName}.php`);
                
                if (fs.existsSync(partialPath1)) {
                    return partialPath1;
                }
                if (fs.existsSync(partialPath2)) {
                    return partialPath2;
                }
                
                viewPath = partialPath1;
            } else {
                viewPath = path.join(controllerDir, `${viewName}.php`);
            }
        } else {
            const documentDir = path.dirname(documentPath);
            
            if (isPartial) {
                const partialPath1 = path.join(documentDir, `_${viewName}.php`);
                const partialPath2 = path.join(documentDir, `${viewName}.php`);
                
                if (fs.existsSync(partialPath1)) {
                    return partialPath1;
                }
                if (fs.existsSync(partialPath2)) {
                    return partialPath2;
                }
                
                viewPath = partialPath1;
            } else {
                viewPath = path.join(documentDir, `${viewName}.php`);
            }
        }

        return viewPath;
    }

    private getControllerInfo(documentPath: string, workspaceRoot: string): { name: string; isInControllers: boolean } | null {
        const relativePath = path.relative(workspaceRoot, documentPath);
        const pathParts = relativePath.split(path.sep);
        
        const viewsIndex = pathParts.indexOf('views');
        if (viewsIndex !== -1 && viewsIndex < pathParts.length - 1) {
            return { name: pathParts[viewsIndex + 1], isInControllers: false };
        }
        
        const controllersIndex = pathParts.indexOf('controllers');
        if (controllersIndex !== -1 && controllersIndex < pathParts.length - 1) {
            const controllerFile = pathParts[controllersIndex + 1];
            const controllerName = controllerFile.replace(/Controller\.php?$/, '').replace(/Controller$/, '');
            // View directories use the controller name with a lowercase first letter (Yii lcfirst)
            return { name: lcFirst(controllerName), isInControllers: true };
        }
        
        const protectedIndex = pathParts.indexOf('protected');
        if (protectedIndex !== -1) {
            for (let i = 0; i < pathParts.length; i++) {
                if (pathParts[i].endsWith('Controller.php')) {
                    const controllerName = pathParts[i].replace(/Controller\.php$/, '');
                    const isInControllers = i > 0 && pathParts[i - 1] === 'controllers';
                    return { name: lcFirst(controllerName), isInControllers };
                }
            }
        }
        
        return null;
    }

    private resolveDotNotationPath(
        workspaceRoot: string,
        viewName: string,
        isPartial: boolean
    ): string | null {
        return resolveDotNotationPath(workspaceRoot, viewName, isPartial);
    }
}

