import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');

describe('repository guards', () => {
  it('checks package.json dependencies', () => {
    const pkgStr = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgStr);
    
    // Only one dependency allowed, must be exact version
    const deps = pkg.dependencies || {};
    const depNames = Object.keys(deps);
    
    expect(depNames).toEqual(['@nrouter_ai/sdk']);
    const version = deps['@nrouter_ai/sdk'];
    expect(version).not.toMatch(/^[\^\~]/); // Must not start with ^ or ~
  });

  function getFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getFiles(res));
      } else {
        files.push(res);
      }
    }
    return files;
  }

  it('checks no node: or fs/path imports in src (except node.ts/cli.ts)', () => {
    const srcDir = path.join(projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return;
    
    const files = getFiles(srcDir);
    for (const file of files) {
      if (file.endsWith('node.ts') || file.endsWith('cli.ts')) continue;
      
      const content = fs.readFileSync(file, 'utf-8');
      
      // Look for imports
      const hasNodeImport = /from\s+['"]node:/g.test(content) || /import\s+['"]node:/g.test(content);
      const hasFsPathImport = /from\s+['"](?:fs|path)['"]/g.test(content) || /import\s+['"](?:fs|path)['"]/g.test(content);
      
      expect(hasNodeImport).toBe(false);
      expect(hasFsPathImport).toBe(false);
    }
  });

  it('checks no fetch() in src (except knowledge/fetch.ts)', () => {
    const srcDir = path.join(projectRoot, 'src');
    if (!fs.existsSync(srcDir)) return;
    
    const files = getFiles(srcDir);
    for (const file of files) {
      // Normalize path for Windows/Unix
      const normalizedPath = file.replace(/\\/g, '/');
      if (normalizedPath.endsWith('src/knowledge/fetch.ts')) continue;
      
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/fetch\(/);
    }
  });

  const forbiddenPatterns = [
    new RegExp(['g', 'u', 'r', 'u'].join(''), 'i'),
    new RegExp(['s', 'u', 'p', 'a', 'b', 'a', 's', 'e'].join(''), 'i'),
    new RegExp(['a', 'z', 'u', 'r', 'e', 'c', 'o', 'n', 't', 'a', 'i', 'n', 'e', 'r', 'a', 'p', 'p', 's'].join(''), 'i'),
    new RegExp(['\\.', 'v', 'a', 'u', 'l', 't', '\\.', 'a', 'z', 'u', 'r', 'e', '\\.', 'n', 'e', 't'].join(''), 'i'),
    new RegExp(['n', 'r', 'o', 'u', 't', 'e', 'r', '-', 'k', 'v'].join(''), 'i'),
    new RegExp(['p', 'j', 'k', 'a', 'x', 'r', 'v', 'v', 'i', 'x', 'p', 'w', 'q', 'm', 't', 'k', 't', 'k', 'g', 'c'].join(''), 'i'),
    new RegExp(['c', 's', 'p', 'i', 'v', 'w', 'n', 'g', 'u', 'a', 'w', 'r', 'f', 'a', 'h', 'y', 'z', 'k', 'n', 'f'].join(''), 'i'),
    new RegExp(['S', 'E', 'R', 'V', 'I', 'C', 'E', '_', 'R', 'O', 'L', 'E'].join('')),
    new RegExp(['s', 'k', '-', 'n', 'r', 'o', 'u', 't', 'e', 'r', '-', '[A-Za-z0-9_-]{20,}'].join(''))
  ];

  it('checks public-leak scan over specified directories', () => {
    const dirsToScan = ['src', 'test', 'examples', 'evals', 'bin'].map(d => path.join(projectRoot, d));
    const filesToScan: string[] = [];
    
    for (const dir of dirsToScan) {
      if (fs.existsSync(dir)) {
        filesToScan.push(...getFiles(dir));
      }
    }
    
    const rootFiles = ['README.md', 'package.json'].map(f => path.join(projectRoot, f));
    for (const file of rootFiles) {
      if (fs.existsSync(file)) {
        filesToScan.push(file);
      }
    }
    
    for (const file of filesToScan) {
      if (file.endsWith('guards.test.ts')) continue; // Skip self
      
      const content = fs.readFileSync(file, 'utf-8');
      
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          throw new Error(`Leak detected in ${file} for pattern ${pattern}`);
        }
      }
    }
  });

  it('self-tests the forbidden patterns', () => {
    const fragments = {
      g: ['g', 'u', 'r', 'u'].join(''),
      s: ['s', 'u', 'p', 'a', 'b', 'a', 's', 'e'].join(''),
      a: ['a', 'z', 'u', 'r', 'e', 'c', 'o', 'n', 't', 'a', 'i', 'n', 'e', 'r', 'a', 'p', 'p', 's'].join(''),
      v: ['.', 'v', 'a', 'u', 'l', 't', '.', 'a', 'z', 'u', 'r', 'e', '.', 'n', 'e', 't'].join(''),
      n: ['n', 'r', 'o', 'u', 't', 'e', 'r', '-', 'k', 'v'].join(''),
      p1: ['p', 'j', 'k', 'a', 'x', 'r', 'v', 'v', 'i', 'x', 'p', 'w', 'q', 'm', 't', 'k', 't', 'k', 'g', 'c'].join(''),
      p2: ['c', 's', 'p', 'i', 'v', 'w', 'n', 'g', 'u', 'a', 'w', 'r', 'f', 'a', 'h', 'y', 'z', 'k', 'n', 'f'].join(''),
      r: ['S', 'E', 'R', 'V', 'I', 'C', 'E', '_', 'R', 'O', 'L', 'E'].join(''),
      k: ['s', 'k', '-', 'n', 'r', 'o', 'u', 't', 'e', 'r', '-', '12345678901234567890'].join('')
    };

    expect(forbiddenPatterns[0]!.test(fragments.g)).toBe(true);
    expect(forbiddenPatterns[1]!.test(fragments.s)).toBe(true);
    expect(forbiddenPatterns[2]!.test(fragments.a)).toBe(true);
    expect(forbiddenPatterns[3]!.test(fragments.v)).toBe(true);
    expect(forbiddenPatterns[4]!.test(fragments.n)).toBe(true);
    expect(forbiddenPatterns[5]!.test(fragments.p1)).toBe(true);
    expect(forbiddenPatterns[6]!.test(fragments.p2)).toBe(true);
    expect(forbiddenPatterns[7]!.test(fragments.r)).toBe(true);
    expect(forbiddenPatterns[8]!.test(fragments.k)).toBe(true);
  });
});
