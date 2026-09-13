package protocol

import "testing"

// The backend inserts history rows keyed by this exact value before it
// publishes, so a mismatch means broadcast results are silently dropped.
func TestDeriveCommandIDMatchesServer(t *testing.T) {
	// Expected values produced by uuid.v5 in Node with the same namespace.
	// Golden values produced by `uuid` v5 in Node with the same namespace.
	// If these drift, broadcast results stop matching their history rows.
	cases := []struct {
		batch, device, want string
	}{
		{
			"303bbf68-2b83-4627-aac6-bbf06178a1c0",
			"dev-6krmjhm2foceof9",
			"25661c25-1938-5864-81a6-2e1e10181c09",
		},
		{"batch-1", "dev-a", "0ee4e9be-7f99-583e-9bda-70e3a1aea9f1"},
		{"x", "y", "e1501fe8-c7c2-5f23-ac11-754d19a55ea8"},
	}
	for _, c := range cases {
		got := DeriveCommandID(c.batch, c.device)
		if len(got) != 36 {
			t.Fatalf("malformed uuid %q", got)
		}
		if got[14] != '5' {
			t.Errorf("expected version 5, got %q", got)
		}
		variant := got[19]
		if variant != '8' && variant != '9' && variant != 'a' && variant != 'b' {
			t.Errorf("expected RFC 4122 variant, got %q", got)
		}
		if c.want != "" && got != c.want {
			t.Errorf("got %s want %s", got, c.want)
		}
	}
}

func TestDeriveCommandIDIsStable(t *testing.T) {
	a := DeriveCommandID("batch-1", "dev-a")
	b := DeriveCommandID("batch-1", "dev-a")
	c := DeriveCommandID("batch-1", "dev-b")
	if a != b {
		t.Errorf("not deterministic: %s vs %s", a, b)
	}
	if a == c {
		t.Error("different devices must derive different ids")
	}
}
