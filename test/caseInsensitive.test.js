const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const { lcFirst, resolvePathCaseInsensitive } = require('../out/infrastructure/utils/moduleUtils');

describe('Case-insensitive view directory resolution', () => {
    let tempRoot;
    let realEntries; // map: lowercased abs dir path -> real entry names

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yii1-ci-'));
        // Simulate the user's project layout: view directory uses lowercase first letter
        fs.mkdirSync(path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member'), { recursive: true });
        fs.writeFileSync(path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member', 'importKeyAccount.php'), '<?php');
        // Another controller with a mixed-case directory
        fs.mkdirSync(path.join(tempRoot, 'protected', 'views', 'sowInfo'), { recursive: true });
        fs.writeFileSync(path.join(tempRoot, 'protected', 'views', 'sowInfo', 'index.php'), '<?php');

        // Build a case-sensitive view of the tree inside tempRoot (as on Linux/macOS).
        realEntries = new Map();
        const walk = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            realEntries.set(dir.toLowerCase(), entries.map(e => e.name));
            for (const e of entries) {
                if (e.isDirectory()) {
                    walk(path.join(dir, e.name));
                }
            }
        };
        walk(tempRoot);
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    // Simulate a case-sensitive filesystem for the tempRoot subtree:
    // - outside tempRoot (OS directories), use the real (case-insensitive) fs
    // - inside tempRoot, a path exists only if every segment matches the real casing
    const caseSensitiveExists = (p) => {
        const abs = path.resolve(p);
        const rel = path.relative(tempRoot, abs);
        if (rel === '') {
            return true; // tempRoot itself exists
        }
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            // Outside tempRoot: the real fs is case-insensitive here
            return fs.existsSync(abs);
        }
        const segments = rel.split(path.sep);
        let current = tempRoot.toLowerCase();
        for (const seg of segments) {
            const entries = realEntries.get(current);
            if (!entries || !entries.includes(seg)) {
                return false;
            }
            current = path.join(current, seg).toLowerCase();
        }
        return true;
    };
    const caseSensitiveReadDir = (p) => {
        const abs = path.resolve(p);
        const rel = path.relative(tempRoot, abs);
        if (rel === '') {
            return realEntries.get(tempRoot.toLowerCase()) || [];
        }
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return [];
        }
        return realEntries.get(path.join(tempRoot.toLowerCase(), rel.toLowerCase())) || [];
    };

    describe('lcFirst', () => {
        it('lowercases the first character', () => {
            assert.strictEqual(lcFirst('Member'), 'member');
            assert.strictEqual(lcFirst('SowInfo'), 'sowInfo');
            assert.strictEqual(lcFirst('member'), 'member');
        });

        it('handles empty and single-character strings', () => {
            assert.strictEqual(lcFirst(''), '');
            assert.strictEqual(lcFirst('M'), 'm');
        });
    });

    describe('resolvePathCaseInsensitive', () => {
        it('returns the path unchanged when it already exists', () => {
            const exact = path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member');
            assert.strictEqual(resolvePathCaseInsensitive(exact, caseSensitiveExists, caseSensitiveReadDir), exact);
        });

        it('resolves a controller view directory with different casing', () => {
            const expected = path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member');
            const input = path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'Member');
            const result = resolvePathCaseInsensitive(input, caseSensitiveExists, caseSensitiveReadDir);
            assert.strictEqual(result, expected);
        });

        it('resolves mixed-case directory names (camelCase first-letter-lowercase)', () => {
            const expected = path.join(tempRoot, 'protected', 'views', 'sowInfo');
            const input = path.join(tempRoot, 'protected', 'views', 'SowInfo');
            const result = resolvePathCaseInsensitive(input, caseSensitiveExists, caseSensitiveReadDir);
            assert.strictEqual(result, expected);
        });

        it('keeps trailing segments as typed when a segment is not found', () => {
            const input = path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'Missing', 'view.php');
            const result = resolvePathCaseInsensitive(input, caseSensitiveExists, caseSensitiveReadDir);
            assert.strictEqual(result, input);
        });

        it('handles relative paths', () => {
            const input = path.join('protected', 'views', 'SowInfo');
            // Mock treats relative paths as relative to tempRoot
            const existsRel = (p) => caseSensitiveExists(path.join(tempRoot, p));
            const readDirRel = (p) => caseSensitiveReadDir(path.join(tempRoot, p));
            const result = resolvePathCaseInsensitive(input, existsRel, readDirRel);
            assert.strictEqual(result, path.join('protected', 'views', 'sowInfo'));
        });
    });
});
