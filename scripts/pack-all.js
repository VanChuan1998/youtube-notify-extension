import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const srcDir = path.resolve('extension');
const distDir = path.resolve('dist');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const manifestPath = path.join(srcDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;

const chromeClientId = '736665623723-cit3ea4m61qtdvsg3vcbqs0jkm0280p4.apps.googleusercontent.com';

function createPackage(browser, modifyManifest) {
  const tmpDir = path.join(distDir, `tmp_${browser}`);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.cpSync(srcDir, tmpDir, { recursive: true });

  const tmpManifestPath = path.join(tmpDir, 'manifest.json');
  const tmpManifest = JSON.parse(fs.readFileSync(tmpManifestPath, 'utf8'));
  
  modifyManifest(tmpManifest);
  
  fs.writeFileSync(tmpManifestPath, JSON.stringify(tmpManifest, null, 2));

  const zipFile = path.join(distDir, `auto-mo-live-${browser}-v${version}.zip`);
  if (fs.existsSync(zipFile)) fs.rmSync(zipFile);

  console.log(`Packaging ${browser} extension to ${zipFile}...`);
  
  const zip = new AdmZip();
  zip.addLocalFolder(tmpDir);
  zip.writeZip(zipFile);
  
  fs.rmSync(tmpDir, { recursive: true });
  console.log(`${browser} package created successfully!`);
}

function main() {
  // 1. Package Chrome
  createPackage('chrome', (m) => {
    delete m.key;
    m.oauth2 = {
      client_id: chromeClientId,
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"]
    };
  });

  // 2. Package Edge
  createPackage('edge', (m) => {
    delete m.key;
    delete m.oauth2;
  });

  console.log('Done packaging for both Chrome and Edge!');
}

main();
