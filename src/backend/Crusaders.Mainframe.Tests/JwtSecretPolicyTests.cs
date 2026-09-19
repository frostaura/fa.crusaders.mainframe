using System.Text.Json;
using Crusaders.Mainframe.Api.Security;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// The signing secret, and the thing that made a placeholder usable.
/// </summary>
/// <remarks>
/// <para>
/// <c>Program.cs</c> asked whether <c>Jwt:Secret</c> was null. <c>appsettings.json</c> supplied
/// <c>DEV_ONLY_REPLACE_WITH_SECURE_JWT_SECRET_VALUE_32_CHARS_MIN</c>, so it never was. A
/// production deployment that forgot <c>Jwt__Secret</c> therefore came up healthy, passed its
/// health check, and signed every session token with a string committed to this repository and
/// baked into the published image — which is all anyone needs to mint a token claiming
/// <c>is_admin</c> for any tenant. The signature would verify, because it would be correct.
/// </para>
/// <para>
/// Two changes, tested here. The secret is gone from the base settings file, so the placeholder
/// cannot be the value by omission; and <see cref="JwtSecretPolicy"/> refuses to start on a
/// missing, short or published secret instead of accepting it silently.
/// </para>
/// </remarks>
public sealed class JwtSecretPolicyTests
{
    private const string Real = "Rr8+uQ2mJk1vPz0aXe7ChN4tYs6WgBdL9fUiOqEz3nM=";
    private const string Placeholder = "DEV_ONLY_REPLACE_WITH_SECURE_JWT_SECRET_VALUE_32_CHARS_MIN";

    [Fact]
    public void A_real_secret_is_accepted_and_returned_trimmed()
    {
        Assert.Equal(Real, JwtSecretPolicy.Resolve($"  {Real}\n", isDevelopment: false));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void A_missing_secret_refuses_to_start_and_names_the_variable(string? secret)
    {
        var error = Assert.Throws<InvalidOperationException>(() => JwtSecretPolicy.Resolve(secret, isDevelopment: false));
        Assert.Contains("Jwt__Secret", error.Message);
    }

    [Fact]
    public void A_key_below_the_HS256_floor_refuses_to_start_rather_than_500ing_on_a_sign_in()
    {
        // 31 bytes. The signing library rejects this too, but at first use — which is a 500 on
        // whoever happens to sign in first, on a service that started and reported healthy.
        var error = Assert.Throws<InvalidOperationException>(
            () => JwtSecretPolicy.Resolve(new string('k', JwtSecretPolicy.MinimumBytes - 1), isDevelopment: false));
        Assert.Contains("32", error.Message);
    }

    [Fact]
    public void The_floor_counts_bytes_not_characters()
    {
        // 16 characters, 48 bytes: accepted, and correctly so. The converse — a 32-character
        // secret that is only 32 bytes because it is ASCII — is the normal case.
        Assert.Equal(new string('é', 24), JwtSecretPolicy.Resolve(new string('é', 24), isDevelopment: false));
    }

    [Theory]
    // The value appsettings.json used to ship.
    [InlineData(Placeholder)]
    // Case and whitespace must not smuggle it through.
    [InlineData("dev_only_replace_with_secure_jwt_secret_value_32_chars_min")]
    [InlineData("  DEV_ONLY_REPLACE_WITH_SECURE_JWT_SECRET_VALUE_32_CHARS_MIN  ")]
    // What docker-compose.prod.yml itself ships. 48 characters, so the length floor waves it
    // through — a stack deployed without editing that line would have been signing with it.
    [InlineData("CHANGE-ME-random-string-of-at-least-32-characters")]
    // The family, not the specific strings: an edited placeholder is still a placeholder.
    [InlineData("CHANGE-ME-no-really-this-time-i-mean-it-32-chars!")]
    [InlineData("REPLACE_WITH_A_PROPER_SECRET_BEFORE_GOING_LIVE_OK")]
    public void A_published_placeholder_cannot_sign_a_token_outside_development(string secret)
    {
        // Each of these clears the length floor, which is the point: length was never what was
        // wrong with them.
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(secret.Trim()) >= JwtSecretPolicy.MinimumBytes);

        var error = Assert.Throws<InvalidOperationException>(() => JwtSecretPolicy.Resolve(secret, isDevelopment: false));
        Assert.Contains("forge", error.Message);
    }

    [Fact]
    public void Development_may_still_use_the_placeholder_so_a_clone_runs_with_no_ceremony()
    {
        Assert.Equal(Placeholder, JwtSecretPolicy.Resolve(Placeholder, isDevelopment: true));
    }

    [Fact]
    public void Development_is_exempt_from_the_placeholder_rule_only_never_from_the_length_floor()
    {
        // A key below 256 bits does not work anywhere, so exempting development from this would
        // only move the failure to a developer's first sign-in.
        Assert.Throws<InvalidOperationException>(() => JwtSecretPolicy.Resolve("short", isDevelopment: true));
    }

    [Fact]
    public void The_base_settings_file_carries_no_signing_secret_at_all()
    {
        // The guard above is the second line. This is the first: with no value in the file that
        // every environment loads, a deployment that forgets Jwt__Secret has nothing to fall
        // back to, and the guard's message is what it sees.
        using var doc = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(ApiProjectDir(), "appsettings.json")));

        Assert.True(doc.RootElement.TryGetProperty("Jwt", out var jwt), "the Jwt section itself should remain");
        Assert.False(jwt.TryGetProperty("Secret", out _),
            "appsettings.json must not carry Jwt:Secret — it is loaded in every environment, so a value here "
            + "is a value production silently falls back to.");
        Assert.True(jwt.TryGetProperty("Issuer", out _), "Issuer is not a secret and belongs here");
    }

    [Fact]
    public void The_development_settings_file_still_supplies_one()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(ApiProjectDir(), "appsettings.Development.json")));

        var secret = doc.RootElement.GetProperty("Jwt").GetProperty("Secret").GetString();
        Assert.False(string.IsNullOrWhiteSpace(secret));
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(secret!) >= JwtSecretPolicy.MinimumBytes);
    }

    /// <summary>Walks up to the API project, which is not copied to the test output directory.</summary>
    private static string ApiProjectDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "src", "backend", "Crusaders.Mainframe.Api");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("The API project was not found above the test binary.");
    }
}
