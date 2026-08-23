param(
  [string]$chatId = "chat-valid-chat-id",
  [string]$token = "",
  [string]$username = "",
  [string]$baseUrl = "http://localhost:3000"
)

if (-not $chatId) {
  Write-Error "chatId is required"
  exit 1
}

$headers = @{}
if ($token -ne "") { $headers.Add('Authorization', "Bearer $token") }
if ($username -ne "") { $headers.Add('x-username', $username) }

$uri = "${baseUrl}/api/private-chats/${chatId}/messages"
Write-Host "GET $uri"
Write-Host "Headers: $(($headers.GetEnumerator() | ForEach-Object { "$($_.Name): $($_.Value)" }) -join ', ')"

try {
  $response = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 30
  Write-Host "Response:`n" -ForegroundColor Green
  $response | ConvertTo-Json -Depth 5 | Write-Host
} catch {
  Write-Host "Request failed:`n$($_.Exception.Message)" -ForegroundColor Red
  if ($_.Exception.Response) {
    try { $_.Exception.Response.GetResponseStream() | %{ new-object System.IO.StreamReader($_) } | Select-Object -First 1 | ForEach-Object { $_ } } catch { }
  }
  exit 1
}
