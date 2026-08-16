# SLATE Git Push 重试脚本
# 后台运行，指数退避避免触发 GitHub rate limit

$maxAttempts = 50
$initialDelay = 30  # 初始等待 30 秒
$maxDelay = 300     # 最大等待 5 分钟
$attempt = 0
$delay = $initialDelay

Write-Host "=== SLATE Git Push 重试脚本 ===" -ForegroundColor Cyan
Write-Host "开始时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

while ($attempt -lt $maxAttempts) {
    $attempt++
    Write-Host "[$attempt/$maxAttempts] 尝试推送... $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Yellow
    
    # 执行 git push
    $output = git push 2>&1
    $exitCode = $LASTEXITCODE
    
    if ($exitCode -eq 0) {
        Write-Host ""
        Write-Host "=== 推送成功! ===" -ForegroundColor Green
        Write-Host "完成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        Write-Host $output
        exit 0
    }
    
    # 检查是否是认证问题（不应该重试）
    if ($output -match "Authentication failed" -or $output -match "could not read Username") {
        Write-Host ""
        Write-Host "=== 认证失败，请检查 Git 凭据 ===" -ForegroundColor Red
        Write-Host $output
        exit 1
    }
    
    # 网络错误，继续重试
    Write-Host "  失败: $($output | Select-Object -First 1)" -ForegroundColor Red
    Write-Host "  等待 $delay 秒后重试..." -ForegroundColor Gray
    
    Start-Sleep -Seconds $delay
    
    # 指数退避：30s -> 45s -> 67s -> 100s -> 150s -> 225s ->  capped at 300s
    $delay = [Math]::Min([Math]::Floor($delay * 1.5), $maxDelay)
}

Write-Host ""
Write-Host "=== 达到最大重试次数 ($maxAttempts)，放弃 ===" -ForegroundColor Red
exit 1
