import torch.nn as nn


class Scale(nn.Module):
    def forward(self, x):
        return x * 2
