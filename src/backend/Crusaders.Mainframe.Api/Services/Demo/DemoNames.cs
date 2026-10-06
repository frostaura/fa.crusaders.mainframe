using System.Text;

namespace Crusaders.Mainframe.Api.Services.Demo;

/// <summary>
/// The made-up people of a demo club: South African first names and surnames drawn in pairs,
/// never repeated within one club, and an initials avatar for each (an SVG data URI — nothing is
/// fetched from anywhere).
/// </summary>
public static class DemoNames
{
    private static readonly string[] First =
    [
        "Thabo", "Lerato", "Sipho", "Naledi", "Pieter", "Annelie", "Johan", "Aisha", "Priya", "Ravi",
        "Zanele", "Bongani", "Kagiso", "Michael", "Sarah", "Jessica", "Liam", "Ethan", "Megan", "Chantelle",
        "Riaan", "Werner", "Nomvula", "Ayanda", "Tshepo", "Lindiwe", "Mpho", "Fatima", "Yusuf", "Imran",
        "Kayla", "Tristan", "Refilwe", "Karabo", "Lwazi", "Busisiwe", "Hendrik", "Elmarie", "Zainab", "Kiran",
        "Nikhil", "Thandeka", "Sibusiso", "Anika", "Ruan", "Simone", "Dineo", "Neo", "Gareth", "Lauren",
        "Mandla", "Palesa", "Jaco", "Carla", "Themba", "Nadia", "Kyle", "Amahle", "Bradley", "Tumi",
    ];

    private static readonly string[] Last =
    [
        "Dlamini", "Nkosi", "Botha", "van der Merwe", "Pillay", "Naidoo", "Khumalo", "Mokoena", "du Plessis", "Pretorius",
        "Smith", "Jacobs", "Ndlovu", "Mahlangu", "Coetzee", "Venter", "Govender", "Mthembu", "Petersen", "Adams",
        "Molefe", "Steyn", "Fourie", "Barnard", "Kruger", "Patel", "Moodley", "Sithole", "Zulu", "Nel",
        "Swanepoel", "Maharaj", "Mabaso", "Hendricks", "Joubert", "Olivier", "Radebe", "Booysen", "Chetty", "Williams",
    ];

    private static readonly string[] Palette =
    [
        "#00498D", "#2F7D6D", "#B5543C", "#6B4FA0", "#A0751F", "#2E6F9E", "#8E3B5E", "#4F7A28", "#9C4A1A", "#3D5A80",
    ];

    /// <summary><paramref name="count"/> distinct full names, drawn from <paramref name="rng"/>.</summary>
    public static List<string> Draw(Random rng, int count, IReadOnlySet<string> taken)
    {
        var names = new List<string>(count);
        var used = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
        var guard = 0;
        while (names.Count < count && guard++ < count * 50)
        {
            var name = $"{First[rng.Next(First.Length)]} {Last[rng.Next(Last.Length)]}";
            if (used.Add(name)) names.Add(name);
        }
        return names;
    }

    /// <summary>A made-up person's address: their name, a number, and the reserved demo domain.</summary>
    public static string EmailFor(string fullName, int n)
    {
        var local = new StringBuilder();
        foreach (var c in fullName.ToLowerInvariant())
        {
            if (char.IsAsciiLetterOrDigit(c)) local.Append(c);
            else if (c == ' ' && local.Length > 0 && local[^1] != '.') local.Append('.');
        }
        return $"{local.ToString().Trim('.')}.{n}@{DemoTenants.EmailDomain}";
    }

    /// <summary>Two-letter initials on a coloured disc, as a data URI the app draws like any photo.</summary>
    public static string Avatar(string fullName, int colour)
    {
        var parts = fullName.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var initials = parts.Length switch
        {
            0 => "?",
            1 => parts[0][..1].ToUpperInvariant(),
            _ => $"{parts[0][0]}{parts[^1][0]}".ToUpperInvariant(),
        };
        var fill = Palette[Math.Abs(colour) % Palette.Length];
        var svg =
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
            $"<rect width='64' height='64' rx='32' fill='{fill}'/>" +
            "<text x='32' y='40' font-family='Arial,sans-serif' font-size='24' font-weight='600' " +
            $"text-anchor='middle' fill='white'>{initials}</text></svg>";
        return "data:image/svg+xml;base64," + Convert.ToBase64String(Encoding.UTF8.GetBytes(svg));
    }
}
