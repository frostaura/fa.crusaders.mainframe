using System.Text;
using Crusaders.Mainframe.Api.Security.Discovery;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// Properties of the beacon codec that a fixture corpus cannot express.
///
/// <para>
/// The corpus pins specific byte strings. What it cannot state is a property that must hold
/// over <i>all</i> inputs — that field order on the wire never changes the signing string,
/// and that no single-bit change anywhere survives verification. Those are the two
/// invariants a canonicalisation exists to provide, and both are the kind of thing that
/// passes every fixture while being wrong.
/// </para>
/// </summary>
public class DiscoveryBeaconTests
{
    private static readonly byte[] Key =
        Convert.FromHexString("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f");

    private static List<KeyValuePair<string, string>> Fields(params (string Key, string Value)[] pairs) =>
        pairs.Select(p => new KeyValuePair<string, string>(p.Key, p.Value)).ToList();

    private static readonly (string, string)[] Announce =
    [
        ("v", "1"),
        ("mac", "5ccf7f1a2b3c"),
        ("hw", "esp8266"),
        ("fw", "1.0.0"),
        ("st", "unclaimed"),
        ("n", "a1b2c3d4e5f60718"),
        ("cch", "a13aa6c2c45e1b1c"),
        ("up", "42"),
    ];

    // ---- Field-order independence -----------------------------------------

    /// <summary>
    /// Two boards that emit the same facts in a different order must reach the same signature.
    ///
    /// <para>
    /// The wire bytes differ — order is preserved on the wire and pinned by the checksum —
    /// but the canonical form sorts, so the signing string and the HMAC are identical. A
    /// canonicalisation that did not sort would make a signature depend on the order the
    /// firmware happened to append fields in, which is the sort of thing that changes when
    /// someone reorders a struct.
    /// </para>
    /// </summary>
    [Fact]
    public void Decode_is_field_order_independent()
    {
        var forward = Fields(Announce);
        var reversed = Fields([.. Announce.Reverse()]);

        var a = DiscoveryBeacon.Decode(DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, forward));
        var b = DiscoveryBeacon.Decode(DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, reversed));

        Assert.True(a.Ok);
        Assert.True(b.Ok);

        // Different bytes on the wire...
        Assert.NotEqual(
            DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, forward),
            DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, reversed));

        // ...and yet the same signing string and the same signature.
        Assert.Equal(
            DiscoveryBeacon.Canonical(a.Frame!.Verb, a.Frame.Fields),
            DiscoveryBeacon.Canonical(b.Frame!.Verb, b.Frame.Fields));

        Assert.Equal(
            DiscoveryBeacon.Sign(Key, a.Frame.Verb, a.Frame.Fields),
            DiscoveryBeacon.Sign(Key, b.Frame.Verb, b.Frame.Fields));

        // Every field survived the round trip, whatever order it arrived in.
        Assert.Equal(
            Announce.Select(p => $"{p.Item1}={p.Item2}").Order(),
            b.Frame.Fields.Select(f => $"{f.Key}={f.Value}").Order());
    }

    /// <summary>Decode preserves wire order. Only <see cref="DiscoveryBeacon.Canonical"/> may sort.</summary>
    [Fact]
    public void Decode_preserves_wire_order()
    {
        var reversed = Fields([.. Announce.Reverse()]);
        var decoded = DiscoveryBeacon.Decode(DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, reversed));

        Assert.Equal(
            reversed.Select(f => f.Key).ToList(),
            decoded.Frame!.Fields.Select(f => f.Key).ToList());
    }

    /// <summary>A field named <c>sig</c> is excluded from what it signs, wherever it appears in the order.</summary>
    [Fact]
    public void Signature_field_is_never_part_of_its_own_signing_string()
    {
        var fields = Fields(Announce);
        var signature = DiscoveryBeacon.Sign(Key, DiscoveryBeacon.Announce, fields);

        var withSignature = new List<KeyValuePair<string, string>>(fields)
        {
            new("sig", signature),
        };

        Assert.Equal(
            DiscoveryBeacon.Canonical(DiscoveryBeacon.Announce, fields),
            DiscoveryBeacon.Canonical(DiscoveryBeacon.Announce, withSignature));

        Assert.True(DiscoveryBeacon.VerifySignature(Key, new BeaconFrame(DiscoveryBeacon.Announce, withSignature)));
    }

    // ---- Single-bit sensitivity -------------------------------------------

    /// <summary>
    /// Every bit of the key participates. 256 flips, one per bit of the 32-byte key.
    /// </summary>
    [Fact]
    public void One_flipped_bit_of_the_key_breaks_verification()
    {
        var frame = SignedFrame();
        Assert.True(DiscoveryBeacon.VerifySignature(Key, frame));

        for (var index = 0; index < Key.Length; index++)
        {
            for (var bit = 0; bit < 8; bit++)
            {
                var mutated = (byte[])Key.Clone();
                mutated[index] ^= (byte)(1 << bit);

                Assert.False(
                    DiscoveryBeacon.VerifySignature(mutated, frame),
                    $"A key with bit {bit} of byte {index} flipped still verified.");
            }
        }
    }

    /// <summary>
    /// Every bit of every signed field participates, and so does every bit of the signature.
    ///
    /// <para>
    /// Flipping the low bit of an ASCII character yields another printable character, so each
    /// mutation is a packet that is still perfectly well-formed and differs from the honest
    /// one by exactly one bit. That is the case a truncated or partially-compared MAC passes.
    /// </para>
    /// </summary>
    [Fact]
    public void One_flipped_bit_of_the_message_or_the_signature_breaks_verification()
    {
        var honest = SignedFrame();
        Assert.True(DiscoveryBeacon.VerifySignature(Key, honest));

        for (var f = 0; f < honest.Fields.Count; f++)
        {
            var value = honest.Fields[f].Value;

            for (var c = 0; c < value.Length; c++)
            {
                var mutatedValue = new StringBuilder(value);
                mutatedValue[c] = (char)(value[c] ^ 0x01);

                var fields = honest.Fields.ToList();
                fields[f] = new KeyValuePair<string, string>(honest.Fields[f].Key, mutatedValue.ToString());

                Assert.False(
                    DiscoveryBeacon.VerifySignature(Key, new BeaconFrame(honest.Verb, fields)),
                    $"Flipping one bit of character {c} in '{honest.Fields[f].Key}' still verified.");
            }
        }
    }

    /// <summary>The verb is signed too: an OFFER's signature must not verify as an ANNOUNCE's.</summary>
    [Fact]
    public void The_verb_participates_in_the_signature()
    {
        var fields = Fields(("v", "1"), ("n", "a1b2c3d4e5f60718"));

        Assert.NotEqual(
            DiscoveryBeacon.Sign(Key, DiscoveryBeacon.Announce, fields),
            DiscoveryBeacon.Sign(Key, DiscoveryBeacon.Offer, fields));
    }

    /// <summary>A frame with no <c>sig</c> at all must not verify — absence is not a pass.</summary>
    [Fact]
    public void A_frame_without_a_signature_does_not_verify()
    {
        Assert.False(DiscoveryBeacon.VerifySignature(Key, new BeaconFrame(DiscoveryBeacon.Announce, Fields(Announce))));
    }

    // ---- Framing -----------------------------------------------------------

    /// <summary>
    /// The checksum covers the body only — from the space after the verb to the star — so a
    /// mutation anywhere in it is caught. The corpus pins one such case; this covers the body
    /// exhaustively.
    /// </summary>
    [Fact]
    public void Any_single_character_change_in_the_body_fails_the_checksum()
    {
        var wire = DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, Fields(Announce)).TrimEnd('\n');
        var bodyStart = "CRSDR1 ANNOUNCE ".Length;
        var bodyEnd = wire.LastIndexOf('*');

        for (var i = bodyStart; i < bodyEnd; i++)
        {
            var mutated = new StringBuilder(wire);
            mutated[i] = (char)(wire[i] ^ 0x01);

            Assert.Equal(DiscoveryBeacon.ErrorBadChecksum, DiscoveryBeacon.Decode(mutated.ToString()).Error);
        }
    }

    /// <summary>Truncation at every length must be refused, and must never throw.</summary>
    [Fact]
    public void Every_truncation_is_refused_without_throwing()
    {
        var wire = DiscoveryBeacon.Encode(DiscoveryBeacon.Announce, Fields(Announce));

        for (var length = 0; length < wire.Length - 1; length++)
        {
            var result = DiscoveryBeacon.Decode(wire[..length]);
            Assert.False(result.Ok, $"A {length}-character prefix decoded as a valid frame.");
            Assert.NotNull(result.Error);
        }
    }

    [Theory]
    [InlineData("K7RM4XPT", true)]
    [InlineData("AAAAAAAA", true)]
    [InlineData("K7RM4XP", false)]      // too short
    [InlineData("K7RM4XPTA", false)]    // too long
    [InlineData("K7RM4XP0", false)]     // zero is not in the alphabet
    [InlineData("K7RM4XPI", false)]     // nor is I
    [InlineData("k7rm4xpt", false)]     // lowercase is not the alphabet either
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Claim_codes_are_checked_against_the_LCD_alphabet(string? code, bool expected)
    {
        Assert.Equal(expected, DiscoveryBeacon.IsWellFormedClaimCode(code));
    }

    /// <summary>
    /// The commitment binds the code to <i>this boot</i>. A new nonce is a new commitment, so
    /// an OFFER or a claim captured on the LAN cannot be replayed against the next boot.
    /// </summary>
    [Fact]
    public void The_commitment_changes_with_the_nonce()
    {
        Assert.NotEqual(
            DiscoveryBeacon.ClaimCommitment("K7RM4XPT", "a1b2c3d4e5f60718"),
            DiscoveryBeacon.ClaimCommitment("K7RM4XPT", "a1b2c3d4e5f60719"));

        Assert.NotEqual(
            DiscoveryBeacon.ClaimCommitment("K7RM4XPT", "a1b2c3d4e5f60718"),
            DiscoveryBeacon.ClaimCommitment("K7RM4XPU", "a1b2c3d4e5f60718"));
    }

    private static BeaconFrame SignedFrame()
    {
        var fields = Fields(Announce);
        var signed = new List<KeyValuePair<string, string>>(fields)
        {
            new("sig", DiscoveryBeacon.Sign(Key, DiscoveryBeacon.Announce, fields)),
        };

        return new BeaconFrame(DiscoveryBeacon.Announce, signed);
    }
}
