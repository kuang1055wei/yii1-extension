const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

// End-to-end simulation of the user's scenario:
// MemberController.php in protected/modules/admin/controllers/
// view directory is protected/modules/admin/views/member/ (lowercase first letter)
// On a case-sensitive filesystem (simulated), the extension must find
// protected/modules/admin/views/member/importKeyAccount.php

const { lcFirst, resolvePathCaseInsensitive } = require('../out/infrastructure/utils/moduleUtils');

describe('End-to-end: controller -> module view directory (case-sensitive fs)', () => {
    let tempRoot;
    let realEntries;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yii1-e2e-'));
        // Simulate the user's project layout
        fs.mkdirSync(path.join(tempRoot, 'protected', 'modules', 'admin', 'controllers'), { recursive: true });
        fs.writeFileSync(
            path.join(tempRoot, 'protected', 'modules', 'admin', 'controllers', 'MemberController.php'),
            '<?php class MemberController extends CController { public function actionImportKeyAccount() { $this->render(\'importKeyAccount\'); } }'
        );
        // View dir is lowercase first letter: member (NOT Member)
        fs.mkdirSync(path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member'), { recursive: true });
        fs.writeFileSync(
            path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member', 'importKeyAccount.php'),
            '<?php echo "view";'
        );

        realEntries = new Map();
        const walk = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            realEntries.set(dir.toLowerCase(), entries.map(e => e.name));
            for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name));
        };
        walk(tempRoot);
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const caseSensitiveExists = (p) => {
        const abs = path.resolve(p);
        const rel = path.relative(tempRoot, abs);
        if (rel === '') return true;
        if (rel.startsWith('..') || path.isAbsolute(rel)) return fs.existsSync(abs);
        const segments = rel.split(path.sep);
        let current = tempRoot.toLowerCase();
        for (const seg of segments) {
            const entries = realEntries.get(current);
            if (!entries || !entries.includes(seg)) return false;
            current = path.join(current, seg).toLowerCase();
        }
        return true;
    };
    const caseSensitiveReadDir = (p) => {
        const abs = path.resolve(p);
        const rel = path.relative(tempRoot, abs);
        if (rel === '') return realEntries.get(tempRoot.toLowerCase()) || [];
        if (rel.startsWith('..') || path.isAbsolute(rel)) return [];
        return realEntries.get(path.join(tempRoot.toLowerCase(), rel.toLowerCase())) || [];
    };

    it('extracts lowercase-first controller name from MemberController.php', () => {
        // Simulates PathResolver.getControllerInfo behavior
        const controllerFile = 'MemberController.php';
        const controllerName = controllerFile.replace(/Controller\.php?$/, '').replace(/Controller$/, '');
        assert.strictEqual(controllerName, 'Member');
        assert.strictEqual(lcFirst(controllerName), 'member');
    });

    it('resolves views/member dir from views/Member and finds the view file', () => {
        const controllerInfoName = lcFirst('Member'); // 'member' (what getControllerInfo now returns)
        const viewsDir = path.join(tempRoot, 'protected', 'modules', 'admin', 'views');
        
        // What the extension now does (resolveControllerViewDir)
        const controllerDir = resolvePathCaseInsensitive(
            path.join(viewsDir, controllerInfoName),
            caseSensitiveExists,
            caseSensitiveReadDir
        );
        
        assert.strictEqual(
            controllerDir,
            path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'member')
        );
        
        // The view file must exist under the resolved directory
        const viewFile = path.join(controllerDir, 'importKeyAccount.php');
        assert.strictEqual(caseSensitiveExists(viewFile), true);
    });

    it('would have failed before the fix (views/Member does not exist)', () => {
        // Before the fix, the extension joined viewsDir + 'Member' (controller class name)
        const wrongDir = path.join(tempRoot, 'protected', 'modules', 'admin', 'views', 'Member');
        assert.strictEqual(caseSensitiveExists(wrongDir), false);
        assert.strictEqual(caseSensitiveExists(path.join(wrongDir, 'importKeyAccount.php')), false);
    });
});
