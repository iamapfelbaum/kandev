package canvasskill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEnsureMaterialized_WritesKandevOwnedCanvasSkill(t *testing.T) {
	home := t.TempDir()

	require.NoError(t, EnsureMaterialized(home))

	root := filepath.Join(home, "system-skills", Slug)
	skill, err := os.ReadFile(filepath.Join(root, "SKILL.md"))
	require.NoError(t, err)
	require.Contains(t, string(skill), "./_kandev/v1")
	require.Contains(t, string(skill), "localStorage")
	require.FileExists(t, filepath.Join(root, "references", "browser-api.md"))
	require.NoDirExists(t, filepath.Join(home, "skills", Slug))
}

func TestReadMaterialized_UsesAllowlistedInventory(t *testing.T) {
	home := t.TempDir()
	require.NoError(t, EnsureMaterialized(home))

	content, err := ReadMaterialized(home, "SKILL.md")
	require.NoError(t, err)
	require.NotEmpty(t, content)
	require.Equal(t, Version, MaterializedVersion(home))

	for _, path := range []string{"../outside.txt", filepath.Join(string(os.PathSeparator), "etc", "passwd"), "missing.md"} {
		_, err := ReadMaterialized(home, path)
		require.Error(t, err, "path %q should be rejected", path)
	}
}

func TestReadMaterialized_RejectsSymlinkedSupportFile(t *testing.T) {
	home := t.TempDir()
	require.NoError(t, EnsureMaterialized(home))
	root := filepath.Join(home, "system-skills", Slug)
	outside := filepath.Join(home, "outside.txt")
	require.NoError(t, os.WriteFile(outside, []byte("secret"), 0o600))
	link := filepath.Join(root, "references", "outside.md")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks are unavailable: %v", err)
	}

	_, err := ReadMaterialized(home, "references/outside.md")
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "allowlisted") || strings.Contains(err.Error(), "symlink"))
}

func TestInventory_IsStableAndContainsSupportingReferences(t *testing.T) {
	inventory := Inventory()
	require.Contains(t, inventory, "SKILL.md")
	require.Contains(t, inventory, "references/manifest.md")
	require.NotEmpty(t, Version)
}
