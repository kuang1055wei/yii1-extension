import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IPathResolver, ViewPathOptions } from '../../domain/interfaces/IPathResolver';
import { IFileRepository } from '../../domain/interfaces/IFileRepository';
import { IConfigurationService } from '../../domain/interfaces/IConfigurationService';
import { getModuleFromPath, resolveDotNotationPath, lcFirst, resolvePathCaseInsensitive } from '../utils/moduleUtils';

/**
 * Path resolver implementation
 * Handles resolution of view paths, controller paths, etc.
 */
export class PathResolver implements IPathResolver {
    constructor(
        private readonly fileRepository: IFileRepository,
        private readonly configService: IConfigurationService
    ) {}

    async resolveViewPath(
        document: vscode.TextDocument,
        viewName: string,
        options: ViewPathOptions
    ): Promise<string | null> {
        const documentPath = document.uri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        
        if (!workspaceFolder) {
            return null;
        }

        const workspaceRoot = workspaceFolder.uri.fsPath;

        // Handle dot notation paths
        if (options.isDotNotation) {
            return this.resolveDotNotationPath(workspaceRoot, viewName, options.isPartial);
        }

        // Handle absolute paths
        if (options.isAbsolute) {
            const pathParts = viewName.substring(1).split('/');
            if (pathParts.length >= 2) {
                const controllerName = pathParts[0];
                const viewFileName = pathParts[pathParts.length - 1];
                
                // Check if current file is in a module
                const moduleName = getModuleFromPath(documentPath, workspaceRoot, this.configService.getModulesPath());
                
                if (moduleName) {
                    // First try module's views directory
                    const moduleViewsDir = this.configService.getViewsDirectory(workspaceRoot, moduleName);
                    const moduleControllerDir = resolvePathCaseInsensitive(
                        path.join(moduleViewsDir, controllerName),
                        (p) => this.fileRepository.existsSync(p)
                    );
                    if (options.isPartial) {
                        // Try both with and without underscore for partials
                        const partialPath1 = path.join(moduleControllerDir, `_${viewFileName}.php`);
                        const partialPath2 = path.join(moduleControllerDir, `${viewFileName}.php`);
                        
                        if (this.fileRepository.existsSync(partialPath1)) {
                            return partialPath1;
                        }
                        if (this.fileRepository.existsSync(partialPath2)) {
                            return partialPath2;
                        }
                        // Return default even if doesn't exist (for linting)
                        return partialPath1;
                    } else {
                        const modulePath = path.join(moduleControllerDir, `${viewFileName}.php`);
                        if (this.fileRepository.existsSync(modulePath)) {
                            return modulePath;
                        }
                    }
                }
                
                // Fallback to main app views directory
                const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
                const controllerDir = resolvePathCaseInsensitive(
                    path.join(viewsDir, controllerName),
                    (p) => this.fileRepository.existsSync(p)
                );
                if (options.isPartial) {
                    // Try both with and without underscore for partials
                    const partialPath1 = path.join(controllerDir, `_${viewFileName}.php`);
                    const partialPath2 = path.join(controllerDir, `${viewFileName}.php`);
                    
                    if (this.fileRepository.existsSync(partialPath1)) {
                        return partialPath1;
                    }
                    if (this.fileRepository.existsSync(partialPath2)) {
                        return partialPath2;
                    }
                    // Return default even if doesn't exist (for linting)
                    return partialPath1;
                } else {
                    return path.join(controllerDir, `${viewFileName}.php`);
                }
            }
        }

        // Handle relative paths
        if (options.isRelative) {
            const documentDir = path.dirname(documentPath);
            const relativePath = viewName.replace(/^\.\.?\//, '');
            let resolvedPath = path.resolve(documentDir, relativePath);
            
            const controllersPath = this.configService.getControllersPath();
            const viewsPath = this.configService.getViewsPath();
            resolvedPath = resolvedPath.replace(
                new RegExp(`[\\/\\\\]${this.escapeRegex(controllersPath)}([\\/\\\\])`, 'g'),
                path.sep + viewsPath + path.sep
            );
            resolvedPath = resolvedPath.replace(
                new RegExp(`[\\/\\\\]${this.escapeRegex(controllersPath)}$`, 'g'),
                path.sep + viewsPath
            );
            
            if (!resolvedPath.endsWith('.php')) {
                resolvedPath = resolvedPath + '.php';
            }
            
            return resolvedPath;
        }

        // Standard view resolution
        const controllerInfo = this.getControllerInfo(documentPath, workspaceRoot);
        
        if (!controllerInfo) {
            const viewsDir = this.configService.getViewsDirectory(workspaceRoot);
            if (this.fileRepository.existsSync(viewsDir)) {
                const commonPaths = [
                    path.join(viewsDir, 'site', `${viewName}.php`),
                    path.join(viewsDir, 'default', `${viewName}.php`)
                ];
                for (const commonPath of commonPaths) {
                    if (this.fileRepository.existsSync(commonPath)) {
                        return commonPath;
                    }
                }
            }
            return null;
        }

        let viewPath: string;
        
        if (controllerInfo.isInControllers) {
            const documentDir = path.dirname(documentPath);
            const controllersPath = this.configService.getControllersPath();
            const viewsPath = this.configService.getViewsPath();
            const viewsDir = documentDir.replace(
                new RegExp(`[\\/\\\\]${this.escapeRegex(controllersPath)}([\\/\\\\]|$)`, 'g'),
                path.sep + viewsPath + path.sep
            );
            
            // Resolve the controller's view directory case-insensitively
            // (the on-disk directory may use a different casing, e.g. "member" vs "Member")
            const controllerDir = resolvePathCaseInsensitive(
                path.join(viewsDir, controllerInfo.name),
                (p) => this.fileRepository.existsSync(p)
            );
            
            if (options.isPartial) {
                const partialPath1 = path.join(controllerDir, `_${viewName}.php`);
                const partialPath2 = path.join(controllerDir, `${viewName}.php`);
                
                if (this.fileRepository.existsSync(partialPath1)) {
                    return partialPath1;
                }
                if (this.fileRepository.existsSync(partialPath2)) {
                    return partialPath2;
                }
                
                viewPath = partialPath1;
            } else {
                viewPath = path.join(controllerDir, `${viewName}.php`);
            }
        } else {
            const documentDir = path.dirname(documentPath);
            
            if (options.isPartial) {
                const partialPath1 = path.join(documentDir, `_${viewName}.php`);
                const partialPath2 = path.join(documentDir, `${viewName}.php`);
                
                if (this.fileRepository.existsSync(partialPath1)) {
                    return partialPath1;
                }
                if (this.fileRepository.existsSync(partialPath2)) {
                    return partialPath2;
                }
                
                viewPath = partialPath1;
            } else {
                viewPath = path.join(documentDir, `${viewName}.php`);
            }
        }

        return viewPath;
    }

    getControllerInfo(documentPath: string, workspaceRoot: string): { name: string; isInControllers: boolean } | null {
        const relativePath = path.relative(workspaceRoot, documentPath);
        const pathParts = relativePath.split(path.sep);
        
        const viewsPath = this.configService.getViewsPath();
        const controllersPath = this.configService.getControllersPath();
        const protectedPath = this.configService.getProtectedPath();
        
        const viewsIndex = pathParts.indexOf(viewsPath);
        if (viewsIndex !== -1 && viewsIndex < pathParts.length - 1) {
            return { name: pathParts[viewsIndex + 1], isInControllers: false };
        }
        
        const controllersIndex = pathParts.indexOf(controllersPath);
        if (controllersIndex !== -1 && controllersIndex < pathParts.length - 1) {
            const controllerFile = pathParts[controllersIndex + 1];
            const controllerName = controllerFile.replace(/Controller\.php?$/, '').replace(/Controller$/, '');
            // View directories use the controller name with a lowercase first letter (Yii lcfirst)
            return { name: lcFirst(controllerName), isInControllers: true };
        }
        
        const protectedIndex = pathParts.indexOf(protectedPath);
        if (protectedIndex !== -1) {
            for (let i = 0; i < pathParts.length; i++) {
                if (pathParts[i].endsWith('Controller.php')) {
                    const controllerName = pathParts[i].replace(/Controller\.php$/, '');
                    const isInControllers = i > 0 && pathParts[i - 1] === controllersPath;
                    return { name: lcFirst(controllerName), isInControllers };
                }
            }
        }
        
        return null;
    }

    resolveDotNotationPath(workspaceRoot: string, viewName: string, isPartial: boolean): string | null {
        return resolveDotNotationPath(workspaceRoot, viewName, isPartial, this.configService);
    }



    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

