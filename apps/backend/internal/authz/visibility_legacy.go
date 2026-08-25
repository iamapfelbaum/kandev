package authz

// Visibility is the reach mechanism the organization unit tree replaced.
//
// The resolver no longer consults it: reach comes from unit membership. The
// type survives only so the column can be dropped in one sweep rather than
// leaving the schema, the DTOs and the interface half-migrated across several
// commits. See docs/plans/org-units/task-05-remove-visibility.md.
type Visibility string

const (
	// VisibilityPrivate is the value every pre-tree workspace carries.
	VisibilityPrivate Visibility = "private"
	// VisibilityOrg marked a workspace as reachable by the whole organization.
	VisibilityOrg Visibility = "org"
)

// NormalizeVisibility coerces an unknown stored value to private.
func NormalizeVisibility(value string) Visibility {
	if Visibility(value) == VisibilityOrg {
		return VisibilityOrg
	}
	return VisibilityPrivate
}
