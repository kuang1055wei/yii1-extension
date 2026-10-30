import * as path from 'path';
import * as fs from 'fs';

/**
 * Lowercase the first character of a string.
 * Yii uses lcfirst(controller class name) as the view directory name,
 * e.g. MemberController -> views/member, SowInfoController -> views/sowInfo.
 */
export function lcFirst(value: string): string {
    if (!value || value.length === 0) {
        return value;
    }
    return value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Resolve a directory path whose case may differ from the one on disk.
 * Tries the exact path first, then walks each segment case-insensitively.
 * 
 * @param dirPath - The path to resolve (e.g. protected/modules/admin/views/Member)
 * @param fsExists - Existence check (sync), injected so tests can mock it
 * @param fsReadDir - Directory listing (sync), injected alongside fsExists so tests can mock a case-sensitive filesystem
 * @returns The on-disk path with correct casing, or the original path if not found
 */
export function resolvePathCaseInsensitive(
    dirPath: string,
    fsExists?: (p: string) => boolean,
    fsReadDir?: (p: string) => string[]
): string {
    const exists = fsExists || ((p: string) => fs.existsSync(p));
    const readDir = fsReadDir || ((p: string): string[] => {
        try {
            return fs.readdirSync(p);
        } catch {
            return [];
        }
    });

    if (!dirPath || dirPath.length === 0) {
        return dirPath;
    }
    if (exists(dirPath)) {
        return dirPath;
    }

    const segments = dirPath.split(/[\\/]/);
    const root = path.parse(dirPath).root;
    let current = root;
    // Absolute paths start at segment 1 (drive letter / leading empty string);
    // relative paths start at segment 0.
    const startIndex = path.isAbsolute(dirPath) ? 1 : 0;

    for (let i = startIndex; i < segments.length; i++) {
        const segment = segments[i];
        if (!segment) {
            continue;
        }
        const parent = current;
        const exact = path.join(parent, segment);
        if (exists(exact)) {
            current = exact;
            continue;
        }
        const entries = readDir(parent);
        const match = entries.find(entry => entry.toLowerCase() === segment.toLowerCase());
        if (match) {
            current = path.join(parent, match);
        } else {
            // Stop resolving; keep the remaining segments as typed
            const rest = segments.slice(i).join(path.sep);
            return path.join(current, rest);
        }
    }

    return current;
}

/**
 * Get multi-level module name/path from a file path
 * 
 * Handles nested modules, e.g., protected/modules/parent/modules/child/controllers/DefaultController.php
 * returns "parent/modules/child"
 * 
 * @param filePath - Full path to the file
 * @param workspaceRoot - Workspace root path
 * @param modulesPathName - Configuration name for modules directory (default: 'modules')
 */
export function getModuleFromPath(filePath: string, workspaceRoot: string, modulesPathName = 'modules'): string | null {
    const relativePath = path.relative(workspaceRoot, filePath);
    const pathParts = relativePath.split(path.sep);
    
    // Find the first index of the modules directory name (e.g. 'modules')
    const firstModulesIndex = pathParts.indexOf(modulesPathName);
    if (firstModulesIndex === -1) {
        return null;
    }
    
    // The module hierarchy segment starts at firstModulesIndex + 1.
    // It should end before the standard Yii directories: 'controllers', 'views', 'models', 'components', 'messages', 'tests'
    const stopKeywords = new Set(['controllers', 'views', 'models', 'components', 'messages', 'tests']);
    
    let endIndex = pathParts.length;
    for (let i = firstModulesIndex + 1; i < pathParts.length; i++) {
        if (stopKeywords.has(pathParts[i].toLowerCase())) {
            endIndex = i;
            break;
        }
    }
    
    // If no stop keyword was found, but the last element is a file (e.g. Module class), exclude it.
    if (endIndex === pathParts.length) {
        const lastPart = pathParts[pathParts.length - 1];
        if (lastPart.includes('.')) {
            endIndex = pathParts.length - 1;
        }
    }
    
    const moduleParts = pathParts.slice(firstModulesIndex + 1, endIndex);
    
    if (moduleParts.length === 0) {
        return null;
    }
    
    // Join using forward slash as standard relative subpath representation
    return moduleParts.join('/');
}

/**
 * Resolve Yii dot notation view path alias
 * 
 * Handles nested subdirectories and nested modules, e.g.
 * "application.views.themes.default.forms.Interview.interview-landing" -> "protected/views/themes/default/forms/Interview/interview-landing.php"
 * 
 * @param workspaceRoot - Workspace root directory
 * @param viewName - Dot notation view name
 * @param isPartial - Whether it is a partial view
 * @param configService - Optional configuration service for custom directories
 */
export function resolveDotNotationPath(
    workspaceRoot: string,
    viewName: string,
    isPartial: boolean,
    configService?: {
        getProtectedPath(): string;
        getViewsPath(): string;
        getViewsDirectory(workspaceRoot: string, moduleName?: string): string;
    }
): string | null {
    const parts = viewName.split('.');
    
    if (parts.length < 3 || parts[0] !== 'application') {
        return null;
    }

    const viewsIndex = parts.indexOf('views');
    const protectedPath = configService ? configService.getProtectedPath() : 'protected';
    const viewsPath = configService ? configService.getViewsPath() : 'views';

    let viewPath: string;

    if (parts[1] === 'modules' && viewsIndex !== -1 && viewsIndex > 2) {
        // Module dot notation, e.g. application.modules.Configuration.views.someDir.someView
        const moduleParts = parts.slice(2, viewsIndex);
        const modulePath = moduleParts.join('/');
        
        const viewParts = parts.slice(viewsIndex + 1);
        if (viewParts.length === 0) {
            return null;
        }
        
        const relativeViewPath = viewParts.join('/');
        
        let viewsDir: string;
        if (configService) {
            viewsDir = configService.getViewsDirectory(workspaceRoot, modulePath);
        } else {
            const modulesPath = 'modules';
            viewsDir = path.join(workspaceRoot, protectedPath, modulesPath, modulePath, viewsPath);
        }
        
        // Resolve the full view directory case-insensitively (module and
        // controller/subdirectory names may use different casing on disk)
        const fullViewDir = resolvePathCaseInsensitive(path.join(viewsDir, relativeViewPath));
        
        if (isPartial) {
            const dir = path.dirname(fullViewDir);
            const file = path.basename(fullViewDir);
            const partialPath1 = path.join(dir, `_${file}.php`);
            const partialPath2 = path.join(dir, `${file}.php`);
            
            if (fs.existsSync(partialPath1)) {
                return partialPath1;
            }
            if (fs.existsSync(partialPath2)) {
                return partialPath2;
            }
            
            viewPath = partialPath1;
        } else {
            viewPath = fullViewDir + '.php';
        }
    } else if (parts[1] === 'views') {
        // Main app views, e.g. application.views.themes.default.forms.Interview.interview-landing
        const viewParts = parts.slice(2);
        if (viewParts.length === 0) {
            return null;
        }
        
        const relativeViewPath = viewParts.join('/');
        
        let viewsDir: string;
        if (configService) {
            viewsDir = configService.getViewsDirectory(workspaceRoot);
        } else {
            viewsDir = path.join(workspaceRoot, protectedPath, viewsPath);
        }
        
        // Resolve the full view directory case-insensitively (controller and
        // subdirectory names may use different casing on disk)
        const fullViewDir = resolvePathCaseInsensitive(path.join(viewsDir, relativeViewPath));
        
        if (isPartial) {
            const dir = path.dirname(fullViewDir);
            const file = path.basename(fullViewDir);
            const partialPath1 = path.join(dir, `_${file}.php`);
            const partialPath2 = path.join(dir, `${file}.php`);
            
            if (fs.existsSync(partialPath1)) {
                return partialPath1;
            }
            if (fs.existsSync(partialPath2)) {
                return partialPath2;
            }
            
            viewPath = partialPath1;
        } else {
            viewPath = fullViewDir + '.php';
        }
    } else {
        return null;
    }

    return viewPath;
}
