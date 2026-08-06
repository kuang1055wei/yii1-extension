import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getModuleFromPath, resolveDotNotationPath } from './infrastructure/utils/moduleUtils';

export class YiiViewDefinitionProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        // Get text around the cursor position (check current line and nearby lines)
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);

        // Find render/renderPartial calls and check if cursor is on a view name
        const renderInfo = this.findRenderCallAtPosition(document, position, startLine, endLine);

        if (!renderInfo) {
            return null;
        }

        const viewPath = this.resolveViewPath(
            document,
            renderInfo.viewName,
            renderInfo.isPartial,
            renderInfo.isRelative,
            renderInfo.isAbsolute,
            renderInfo.isDotNotation
        );

        if (viewPath && fs.existsSync(viewPath)) {
            return new vscode.Location(
                vscode.Uri.file(viewPath),
                new vscode.Position(0, 0)
            );
        }

        // Return the path even if file doesn't exist (for better UX)
        if (viewPath) {
            return new vscode.Location(
                vscode.Uri.file(viewPath),
                new vscode.Position(0, 0)
            );
        }

        return null;
    }

    private findRenderCallAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position,
        startLine: number,
        endLine: number
    ): { viewName: string; isPartial: boolean; isRelative: boolean; isAbsolute: boolean; isDotNotation: boolean } | null {
        // Pattern to match render('view') or renderPartial('view')
        // Also matches: $this->render('view'), self::renderPartial('view'), etc.
        const renderPattern = /(?:->|::)\s*(render(?:Partial)?)\s*\(\s*['"]([^'"]+)['"]/g;

        // Check each line in the range
        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            const line = document.lineAt(lineNum);
            const lineText = line.text;
            let match;

            // Find all render calls on this line
            while ((match = renderPattern.exec(lineText)) !== null) {
                // Find the position of the view name string
                const quoteChar = match[0].includes("'") ? "'" : '"';
                const viewNameStart = match.index + match[0].indexOf(quoteChar) + 1;
                const viewNameEnd = match.index + match[0].lastIndexOf(quoteChar);

                // Check if cursor is on this line and within the view name
                if (lineNum === position.line) {
                    if (position.character >= viewNameStart && position.character < viewNameEnd) {
                        const viewName = match[2];
                        const isPartial = match[1] === 'renderPartial';
                        const isRelative = viewName.startsWith('../') || viewName.startsWith('./');
                        const isAbsolute = viewName.startsWith('/');
                        const isDotNotation = viewName.includes('.') && !isRelative && !isAbsolute;

                        return {
                            viewName,
                            isPartial,
                            isRelative,
                            isAbsolute,
                            isDotNotation
                        };
                    }
                }
            }
        }

        return null;
    }

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

        // Handle dot notation paths like application.modules.Sow.views.sow.sow_info
        if (isDotNotation) {
            return this.resolveDotNotationPath(workspaceRoot, viewName, isPartial);
        }

        // Handle absolute paths like /controller/viewName
        if (isAbsolute) {
            if (viewName.startsWith('//')) {
                const pathParts = viewName.substring(2).split('/');
                if (pathParts.length >= 2) {
                    const controllerName = pathParts[0];
                    const viewFileName = pathParts[pathParts.length - 1];

                    // Check if current file is in a module
                    // const moduleName = this.getModuleFromPath(documentPath, workspaceRoot);

                    // if (moduleName) {
                    //     // First try module's views directory
                    //     const moduleViewsPath = path.join(workspaceRoot, 'protected', 'modules', moduleName, 'views', controllerName);
                    //     if (isPartial) {
                    //         // Try both with and without underscore for partials
                    //         const partialPath1 = path.join(moduleViewsPath, `${viewFileName}.php`);

                    //         if (fs.existsSync(partialPath1)) {
                    //             return partialPath1;
                    //         }
                    //         // Return default even if doesn't exist (for navigation)
                    //         return partialPath1;
                    //     } else {
                    //         const modulePath = path.join(moduleViewsPath, `${viewFileName}.php`);
                    //         if (fs.existsSync(modulePath)) {
                    //             return modulePath;
                    //         }
                    //     }
                    // }

                    // Fallback to main app views directory
                    const mainViewsPath = path.join(workspaceRoot, 'protected', 'views', controllerName);
                    if (isPartial) {
                        // Try both with and without underscore for partials
                        const partialPath1 = path.join(mainViewsPath, `${viewFileName}.php`);

                        if (fs.existsSync(partialPath1)) {
                            return partialPath1;
                        }
                        // Return default even if doesn't exist (for navigation)
                        return partialPath1;
                    } else {
                        return path.join(mainViewsPath, `${viewFileName}.php`);
                    }
                }
            }
            else {
                const pathParts = viewName.substring(1).split('/');
                if (pathParts.length >= 2) {
                    const controllerName = pathParts[0];
                    const viewFileName = pathParts[pathParts.length - 1];

                    // Check if current file is in a module
                    const moduleName = getModuleFromPath(documentPath, workspaceRoot);

                    if (moduleName) {
                        // First try module's views directory
                        const moduleViewsPath = path.join(workspaceRoot, 'protected', 'modules', moduleName, 'views', controllerName);
                        if (isPartial) {
                            // Try both with and without underscore for partials
                            const partialPath1 = path.join(moduleViewsPath, `${viewFileName}.php`);

                            if (fs.existsSync(partialPath1)) {
                                return partialPath1;
                            }
                            // Return default even if doesn't exist (for navigation)
                            return partialPath1;
                        } else {
                            const modulePath = path.join(moduleViewsPath, `${viewFileName}.php`);
                            if (fs.existsSync(modulePath)) {
                                return modulePath;
                            }
                        }
                    }

                    // Fallback to main app views directory
                    const mainViewsPath = path.join(workspaceRoot, 'protected', 'views', controllerName);
                    if (isPartial) {
                        // Try both with and without underscore for partials
                        const partialPath1 = path.join(mainViewsPath, `${viewFileName}.php`);

                        if (fs.existsSync(partialPath1)) {
                            return partialPath1;
                        }
                        // Return default even if doesn't exist (for navigation)
                        return partialPath1;
                    } else {
                        return path.join(mainViewsPath, `${viewFileName}.php`);
                    }
                }
            }
        }

        // Handle relative paths like ../layouts/viewName or ../controller/viewName
        if (isRelative) {
            const documentDir = path.dirname(documentPath);
            // Remove leading ../ or ./
            const relativePath = viewName.replace(/^\.\.?\//, '');

            // If the path contains "controllers", replace it with "views"
            let resolvedPath = path.resolve(documentDir, relativePath);

            // Replace "controllers" with "views" in the path if present
            resolvedPath = resolvedPath.replace(/[/\\]controllers([/\\])/g, path.sep + 'views' + path.sep);
            resolvedPath = resolvedPath.replace(/[/\\]controllers$/g, path.sep + 'views');

            // If the resolved path doesn't have .php extension, add it
            if (!resolvedPath.endsWith('.php')) {
                resolvedPath = resolvedPath + '.php';
            }

            if (fs.existsSync(resolvedPath)) {
                return resolvedPath;
            }

            // Also try without .php extension (in case it was already in the path)
            const pathWithoutExt = resolvedPath.replace(/\.php$/, '');
            if (fs.existsSync(pathWithoutExt)) {
                return pathWithoutExt;
            }

            // Return the expected path even if it doesn't exist
            return resolvedPath;
        }

        // Determine controller name from current file path
        // If file is in controllers folder, replace "controllers" with "views" (preserving modules, etc.)
        const controllerInfo = this.getControllerInfo(documentPath, workspaceRoot);

        if (!controllerInfo) {
            // Fallback: try to find protected/views directory
            const protectedViewsPath = path.join(workspaceRoot, 'protected', 'views');
            if (fs.existsSync(protectedViewsPath)) {
                // Try common locations
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

        // Build view path by replacing "controllers" with "views" in the original path
        // This preserves modules and other path components
        let viewPath: string;

        if (controllerInfo.isInControllers) {
            // Replace "controllers" with "views" in the document path
            // Example: protected/modules/admin/controllers/AdminController.php
            //          -> protected/modules/admin/views/admin/view.php
            const documentDir = path.dirname(documentPath);
            const viewsDir = documentDir.replace(/[/\\]controllers([/\\]|$)/g, path.sep + 'views' + path.sep);

            if (isPartial) {
                // Partials can be with or without underscore prefix
                const partialPath1 = path.join(viewsDir, controllerInfo.name, `${viewName}.php`);

                if (fs.existsSync(partialPath1)) {
                    return partialPath1;
                }

                viewPath = partialPath1; // Default to underscore version
            } else {
                viewPath = path.join(viewsDir, controllerInfo.name, `${viewName}.php`);
            }
        } else {
            // Already in views directory, just append the view name
            const documentDir = path.dirname(documentPath);

            if (isPartial) {
                // Partials can be with or without underscore prefix
                const partialPath1 = path.join(documentDir, `${viewName}.php`);

                if (fs.existsSync(partialPath1)) {
                    return partialPath1;
                }

                viewPath = partialPath1; // Default to underscore version
            } else {
                viewPath = path.join(documentDir, `${viewName}.php`);
            }
        }

        return viewPath;
    }



    private getControllerInfo(documentPath: string, workspaceRoot: string): { name: string; isInControllers: boolean } | null {
        // Try to extract controller name from file path
        // Common patterns:
        // - protected/views/{controller}/{view}.php
        // - protected/controllers/{controller}Controller.php

        const relativePath = path.relative(workspaceRoot, documentPath);
        const pathParts = relativePath.split(path.sep);

        // Check if we're in views directory
        const viewsIndex = pathParts.indexOf('views');
        if (viewsIndex !== -1 && viewsIndex < pathParts.length - 1) {
            return { name: pathParts[viewsIndex + 1], isInControllers: false };
        }

        // Check if we're in controllers directory
        // When render happens from controllers folder, replace controllers with views
        const controllersIndex = pathParts.indexOf('controllers');
        if (controllersIndex !== -1 && controllersIndex < pathParts.length - 1) {
            const controllerFile = pathParts[controllersIndex + 1];
            // Remove Controller.php or Controller suffix
           const controllerName = controllerFile
                .replace(/Controller\.php?$/, '')
                .replace(/Controller$/, '');

            const viewControllerName =
                controllerName.charAt(0).toLowerCase() + controllerName.slice(1);

            return { name: viewControllerName, isInControllers: true };
        }

        // Try to find protected directory and infer from structure
        const protectedIndex = pathParts.indexOf('protected');
        if (pathParts[i].endsWith('Controller.php')) {
            const controllerName = pathParts[i]
                .replace(/Controller\.php$/, '');

            const viewControllerName =
                controllerName.charAt(0).toLowerCase()
                + controllerName.slice(1);

            const isInControllers =
                i > 0 && pathParts[i - 1] === 'controllers';

            return {
                name: viewControllerName,
                isInControllers
            };
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

