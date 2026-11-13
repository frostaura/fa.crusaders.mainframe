using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Crusaders.Mainframe.Tests;

/// <summary>
/// A real member photo for a test registration (BP-06, BA-13): the API now refuses an application
/// without one it issued to the club, so a test that registers uploads one first — exactly as the
/// PWA's registration screen does.
/// </summary>
public static class TestPhotos
{
    /// <summary>The first bytes of a PNG, then filler: enough for the upload's byte sniff.</summary>
    public static byte[] Png(int length = 64)
    {
        var bytes = new byte[Math.Max(length, 8)];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(bytes, 0);
        return bytes;
    }

    /// <summary>Multipart form content carrying <paramref name="bytes"/> as the <c>file</c> part.</summary>
    public static MultipartFormDataContent Form(byte[] bytes, string declaredType = "image/png", string fileName = "face.png")
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(declaredType);
        return new MultipartFormDataContent { { content, "file", fileName } };
    }

    /// <summary>
    /// Uploads a photo through the anonymous registration upload and answers its URL. The client
    /// must already address the club (its Host header), as an applicant's browser does.
    /// </summary>
    public static async Task<string> UploadAsync(HttpClient clubClient)
    {
        using var form = Form(Png());
        using var response = await clubClient.PostAsync("/api/v1/uploads/photo", form);
        var text = await response.Content.ReadAsStringAsync();
        if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException($"photo upload answered {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.GetProperty("url").GetString()!;
    }

    /// <summary>Registers an applicant with a freshly uploaded photo; answers the response.</summary>
    public static async Task<HttpResponseMessage> RegisterAsync(
        HttpClient clubClient, string email, string membershipNumber, string fullName = "New Applicant", string password = "Pass1234!")
    {
        var photo = await UploadAsync(clubClient);
        return await clubClient.PostAsJsonAsync("/api/v1/auth/register", new
        {
            email, password, fullName, membershipNumber, photoUrl = photo,
        });
    }
}
